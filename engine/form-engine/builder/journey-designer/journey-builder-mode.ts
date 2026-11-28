/**
 * The Journeys mode of `<datum-builder>`: the form's journeys — one page
 * or many; a one-page journey with its heading hidden is the form asked another way: there is no separate "form variant" — one entry each in the documents dropdown,
 * edited with the builder's own palette, canvas and inspector —
 * each journey over a controller of its own, following the PDF layouts.
 * Undo and selection survive a move between journeys and tabs; drafts do not, since every move
 * goes through the shell's leave prompt, which saves or discards them first. The palette offers
 * Page, Form field, Route and Worked-out value, then the page-only fields — the form's own types;
 * a route's condition is edited in the Logic
 * workspace's Go to rule (`logic-journey-host.ts`, one undo step on the journey's controller),
 * stored as the node's `when` (never as `ComponentRules`); a worked-out value's expression is
 * edited on the Rules tab (its `value`); the `+` makes a journey that is one empty step, filled from
 * the Form fields strip panel (`formFields`, offered while the Step view is up) and mended from the
 * findings card at the top of the Journey panel (`findings`, with the fixes: Ask it here, Make it
 * optional on the form, Remove); the
 * active journey's `⋯` menu renames it (the name only: the id stays), copies it, makes it the
 * default and removes it — down to none. These catalog actions are not undoable, as with PDF.
 *
 * The mode holds the catalog (`JourneyModeModel`) and reports every change through its options'
 * callbacks; an element wraps them in DOM events. Until the first edit the block it reports is
 * the one it was given, object and all, so a definition written back is the one read, byte for
 * byte; unknown keys, unreadable journeys and later journeys sharing an id are always kept.
 *
 * A journey whose pages hold nodes of its own (page-only fields, aliases, worked-out
 * values, references inside layouts of its own — object entries beside the component ids) opens
 * like any other: its tree holds those nodes as written (`journey-tree.ts`), so it is saved byte
 * for byte until it is edited, and an edit writes them back as they stand. A form component
 * renamed is followed into them, in the catalog and in an open tree (`journey-references.ts`);
 * a node of its own renamed in its tree is followed into the journey's own rules and worked-out
 * values; and the ids its nodes carry are claimed for the form (`claimedIds`), as the tree
 * stands, so the form never makes or renames a component onto one. Authoring them — the palette's page-only fields, "Fills form field", "Ask differently
 * here…" (`askDifferently`), the fix-its on their findings — comes from a chunk of the
 * designer's own, loaded with it before any journey is built (`loadJourneyAuthoring`).
 *
 * The mode and the catalog are in the builder's bundle; the designer — the tree mapping, the
 * Step view, the generator, the findings (`journey-diagnostics.ts`) and the add popover — is a chunk
 * of its own, loaded by the first `activate()` (`loadJourneyDesigner`, retried after a failed
 * load), so every host gets it with no loader wiring and a page that never opens the tab never
 * loads it. Meanwhile the dropdown already lists the journeys, since listing needs no designer.
 *
 * The form is read live through its controller (`options.form`, the shell's, never replaced):
 * its tree for the faces and pickers, its locale and its locales. A form edit repaints the
 * journey on the page and never rebuilds a journey's controller, which would take its history.
 * A form component renamed on the Form tab (`BuilderChangeEvent.renamed`) is followed into every
 * journey, in place, reported with the reason `"form-rename"`, and so is
 * an Undo or a Redo of the rename (`BuilderChangeEvent.renameStepped`); a form
 * component deleted is not — it shows as a stale question, which the form's own undo repairs.
 *
 * What a host sees change once it registers the mode:
 * - `modes` gains `{ id: "journeys", label: "Journeys" }`; beside the PDF mode, the bar's `+`
 *   on the form's tab opens a menu ("New journey…", "New layout…") instead of the PDF popover.
 * - Its changes come as `onChange` details with `reason` a builder reason for an edit on the
 *   canvas, `"journeys"` for the catalog (add, rename, copy, remove, default, opens as), or
 *   `"form-rename"`; a host wrapping them in `datum-builder-change` reports mode `"journeys"`.
 * - The Variables panel lists `"conditions"` while the mode is on the page.
 * - The Form panel on the form's tab gains an "Opens as" row under "Journeys" while the form
 *   has a journey (`formSettings`), drafted and saved with the form's own settings.
 * - The definition's `journey` block is this mode's (`journeyConfiguration`).
 * - The Languages workspace lists every journey's texts after the form's (`translatableTexts`),
 *   each with the address its translations live at in the definition's map:
 *   `journeys › <journeyId> › name`, `journeys › <journeyId> › pages › <pageId> › title`. The
 *   journeys' block holds the default strings only. A page or a journey removed has its
 *   translations pruned from every language, a page or a journey given another id has them
 *   moved, and a journey copied has them copied, each as one step of the form's history.
 *
 * The bar's Map | Step switch chooses what the canvas shows. Map draws the
 * journey as a flow map — its steps, one box each, and every way between them, Top down or
 * Left to right (`mapLayout`, remembered per viewer
 * under the shell's `persist-panels` key) — from a chunk of
 * its own the designer loads on the first Map; a click on it selects what it draws, and the
 * inspector edits it. While the chunk loads, a note stands in its place; a load that
 * fails is said once and tried again on the next Map. Step draws one step on the Form canvas as
 * the person sees it (`step-view.ts`); a step is opened from the map's Open (or Enter, or a
 * double click), the picker or Try it's "Open this step".
 *
 * Try it on the canvas bar runs the journey: the canvas draws the FORM over the try session's runtime (`tryIt.session`), a real
 * runtime over the form whose journeys are the tree as it stands, drafts included, so an edit
 * in the inspector changes the path as it is typed. A host supplies the runtime
 * (`previewRuntime`), or the engine builds its own over the form's field constraints alone. The
 * session lives in the designer's `journey-preview.ts`, a chunk of its own the mode loads ahead
 * once a journey is on the page; the Try panel leads with its Journey card (`tryIt.cards`). The
 * session starts from the canvas's one set of answers and hands them back when Try it ends.
 */
import type { JourneyNavigationResult, JourneyTrace, JourneyView } from "../../core/journey/journey-types.js";
import type { ComponentDefinition, TranslationCatalog } from "../../core/schema/contracts.js";
import {
  addressOf,
  copyTranslations,
  listTranslations,
  moveTranslations,
  pruneTranslations,
  isStale,
  readTranslation,
  resolveText,
  writeTranslation,
  type FormTranslations,
  type TextAddress,
  type TextSources,
  type TranslationEntry,
  type TranslationPrefix
} from "../../core/localization/translations.js";
import { JOURNEY_END, PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE, findJourney, type Journey, type JourneyConfiguration } from "../../core/schema/journey.js";
import type { ComponentNode, LocalizationConfiguration } from "../../core/schema/types.js";
import type { RenderHostRuntime } from "../../render/web-component/form-renderer-element.js";
import { carryChange, carryMembership, hasId, sameData, type OutsideDocument } from "../../core/localization/locale-documents.js";
import type { BuilderCommand } from "../history/command-history.js";
import type { RenamedTextId } from "../controller/translation-rules.js";
import { collectionPathOf, holdsData } from "../../core/tree/data-scope.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import { journeyOwnership } from "../../core/journey/journey-path.js";
import { BuilderController, type BuilderChangeEvent, type BuilderChangeReason, type TranslatableText } from "../controller/builder-controller.js";
import { formulaFieldsOf, type FormulaField } from "../formula/formula-fields.js";
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import type { InspectorChoice } from "../property-editor/inspector-model.js";
import { applicableRuleDescriptors, type RuleDescriptor } from "../property-editor/rules-model.js";
import type {
  BuilderDocument,
  BuilderDocuments,
  BuilderFormSettingRow,
  BuilderFormSettings,
  BuilderMode,
  BuilderModeAddOptions,
  BuilderModeContext,
  BuilderModeChoice,
  BuilderModeFinding,
  BuilderModeFormFieldRow,
  BuilderModeFormFields,
  BuilderModeHistory,
  BuilderModeInspection,
  BuilderInspectorAction,
  BuilderModeRules,
  BuilderModeWays,
  BuilderModeTryIt,
  BuilderPrintSession,
  BuilderTrySession
} from "../web-component/builder-modes.js";
import { ruleFieldOptions } from "../web-component/builder-shared.js";
import { builderText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { registerLogicJourneyHost, type LogicJourneyHost, type LogicOpenRequest, type LogicRouteRef } from "../logic/logic-journey-host.js";
import { appliedStep, formStepsOnPage } from "../history/form-steps-on-page.js";
import { formTranslationsOf, ownNodeIdsOf, rewriteFormTranslations, setJourneyDefaults } from "./journey-texts.js";
import {
  addJourney,
  canonicalJourneyConfiguration,
  chooseOpensAs,
  duplicateJourney,
  journeyIdFromName,
  journeyLabel,
  journeyLabelText,
  type JourneyTextRow,
  journeysOf,
  journeyUnusableProblems,
  journeyTranslatableTexts,
  removeJourney,
  replaceJourney,
  setDefaultJourney,
  setOpensAs,
  takenJourneyIds,
  uniqueJourneyId,
  type DuplicateJourneyOptions,
  type JourneyOpensAs
} from "./journey-catalog.js";
import {
  normalizeJourneyMapLayout,
  readJourneyMapLayout,
  writeJourneyMapLayout,
  type JourneyMapLayout
} from "../journey-map/journey-map-preferences.js";
import type {
  JourneyAddChoice,
  JourneyAddPopover,
  JourneyDesigner,
  JourneyEmptyState,
  JourneyEntryDesign,
  JourneyFindingFix,
  JourneyMap,
  JourneyMapSubject,
  JourneyPreviewSession,
  JourneyPreviewSubject,
  JourneyStepView,
  JourneyTrySessionMaker
} from "./journey-designer.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_ID,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT,
  JourneyModeModel,
  journeyChange,
  journeyHasOnePage
} from "./journey-mode-model.js";
import { journeyOwnNodeIds, journeyRenameEdits, journeyTreeOwnIds } from "./journey-references.js";

// The id lives with the mode's loader, so naming the mode never carries the mode.
import { JOURNEY_BUILDER_MODE } from "./journey-mode-loader.js";

export { JOURNEY_BUILDER_MODE };

export type { JourneyMapLayout } from "../journey-map/journey-map-preferences.js";

/** The designer chunk, as `loadJourneyDesigner` resolves it. */
export type JourneyDesignerModule = typeof import("./journey-designer.js");

/** One load of the designer per page, shared by every Journeys mode on it. */
let designerLoad: Promise<JourneyDesignerModule> | undefined;

/**
 * The Journeys designer's chunk, loaded on demand: what `activate()` awaits. A failed
 * load (the chunk missing from the page's copy of the bundle, a network hiccup) is tried again
 * next time rather than remembered, so the tab is not broken for the rest of the page's life.
 */
export function loadJourneyDesigner(): Promise<JourneyDesignerModule> {
  if (!designerLoad) {
    const load = import("./journey-designer.js");
    load.catch(() => {
      if (designerLoad === load) {
        designerLoad = undefined;
      }
    });
    designerLoad = load;
  }
  return designerLoad;
}

/** A change to the definition's journeys. */
export interface JourneyBuilderModeChangeDetail {
  /** The journey the change concerns — edited, added, renamed, copied, removed, made the default — when there is one. */
  journey?: Journey | undefined;
  /** The definition's `journey` block as it stands: `undefined` once edited down to saying nothing. */
  configuration: JourneyConfiguration | undefined;
  /**
   * A builder reason for an edit on the canvas or in the inspector; `"journeys"` for the catalog; `"form-rename"` for a rename followed;
   * `"page-rename"` after the edit that gave a page of the journey another id (the Tests follow it), `renamed` saying which.
   */
  reason: BuilderChangeReason | "journeys" | "form-rename" | "page-rename" | "journey-rename";
  /** The journey the page moved to with this change, when it moved. */
  select?: string | undefined;
  /** With `"page-rename"` (or `"journey-rename"`): the journey and the page id (or journey id) it had and has now. */
  renamed?: { journeyId: string; from: string; to: string } | undefined;
}

/** The page moved to another of the form's journeys. Nothing in the definition changed. */
export interface JourneyBuilderModeSelectDetail {
  journeyId: string;
  journey: Journey;
}

/**
 * What the canvas shows of the journey on the page: its flow map (the
 * default) or one step edited as the person sees it. The preview left the bar for Try it;
 * "preview" or "pages" from an old caller or stored value reads as "map".
 */
export type JourneyModeView = "map" | "step";

/** The bar's Map | Step buttons' words, from the builder's text tables. */
const VIEW_WORDS: Readonly<Record<JourneyModeView, { label: BuilderTextKey; title: BuilderTextKey }>> = {
  map: { label: "journey.mode.view.map", title: "journey.mode.view.mapTitle" },
  step: { label: "journey.mode.view.step", title: "journey.mode.view.stepTitle" }
};

/** What a host is asked for when the Journeys mode runs a journey in Try it (`previewRuntime`). */
export interface JourneyPreviewRuntimeRequest {
  /**
   * The journeys the preview runs, for the runtime's `journeyConfiguration` as it is (a
   * function, read on every recompute): the journey on the page as it stands, drafts included,
   * alone and its own default. Its pages go by the designer's node ids, so a page keeps its
   * place while its id is typed; the definition's own block is not what a preview runs.
   */
  journeyConfiguration: () => JourneyConfiguration | undefined;
  /** The journey the runtime opens as (its `journey`). */
  journeyId: string;
  /** The builder's locale; the mode switches the runtime to it when the runtime opens in another. */
  locale: string;
  /** The form as committed, for a host that builds the runtime's definition from it. */
  root: ComponentNode;
  /** The form's locales as committed. */
  localization: LocalizationConfiguration | undefined;
  /**
   * The form's translations as committed, for a host that builds the runtime's
   * definition from `root`: a journey's name and its pages' titles are worded there, and the
   * pages are keyed by the preview's node ids (the entries of a page written under another id
   * are moved to its node id).
   */
  translations?: FormTranslations | undefined;
}

/**
 * The runtime a preview runs on: what the renderer needs, and the journey calls the preview
 * makes. A `FormRuntime` built with the request's `journeyConfiguration` and `journey` is one;
 * that option is what makes it a preview, which is never checked against a server.
 */
export interface JourneyPreviewRuntime extends RenderHostRuntime {
  /** Re-reads `journeyConfiguration` and works the path out again. */
  refreshJourney(): void;
  journeyView(): JourneyView | undefined;
  /**
   * The path and the decisions it was worked out by (`FormRuntime.journeyTrace`), which Try it's
   * map marks the way taken from. Optional: a runtime that cannot say it has only its step marked.
   */
  journeyTrace?(): JourneyTrace | undefined;
  startJourney(journeyId?: string, options?: { pageId?: string }): JourneyNavigationResult;
}

export interface JourneyBuilderModeOptions {
  /** The shell's form controller (`<datum-builder>.controller`): the form the journeys are built over, read live. */
  form: BuilderController;
  /** The definition's `journey` block to start from; anything but an object reads as none. */
  journey?: unknown;
  /** Which journey to put on the page first; absent, the default. */
  journeyId?: string | undefined;
  /** The host's catalog, for journey names and labels keyed there. */
  translations?(): TranslationCatalog | undefined;
  /**
   * The builder's own words per locale (`<datum-builder>.textCatalog`), read live: the designer,
   * its map, try session and checks, and the rows listed for the Languages workspace use it.
   * Absent: the shell hands its own over when the mode is added (`BuilderMode.textCatalog`).
   */
  textCatalog?: (() => BuilderTextCatalog | undefined) | undefined;
  /** Which leaves carry no answer (a host's own static components). Absent: the engine's. */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
  /**
   * The form's component definitions, as the host registers them for the form's builder: what
   * a presentation's page-only fields are made from, read when a journey's designer
   * is built. Absent: the designer offers no page-only field, and draws those a journey holds.
   */
  formDefinitions?: (() => readonly ComponentDefinition[] | undefined) | undefined;
  /**
   * The runtime Try it runs the journey on, built by the host as it builds its own
   * forms' — with its validators and data sources, and without drafts, a sandbox or anything
   * that delivers, since nothing is submitted from Try it. Called again for Restart and when
   * the form's tree or locales change (the answers are replayed into the new one). Absent: the
   * engine's own, over the form's field constraints alone, which the Journey card says.
   */
  previewRuntime?: ((request: JourneyPreviewRuntimeRequest) => JourneyPreviewRuntime) | undefined;
  onChange?(detail: JourneyBuilderModeChangeDetail): void;
  onSelect?(detail: JourneyBuilderModeSelectDetail): void;
  /** The designer could not load, an edit could not be kept, a catalog action was refused. */
  onError?(message: string, cause?: unknown): void;
}

export interface NewJourneyOptions {
  /** Blank or absent: "Journey", "Journey 2", …, or the copy's own name. */
  name?: string | undefined;
  /**
   * `"blank"`: one empty questions step (what the add popover makes). A copy of the journey on
   * the page. Or the form in one of its shapes, for a caller that names one (an agent): a one-page
   * shape starts titled as the form with its page heading hidden: it looks
   * like the form until the author changes it.
   */
  from: JourneyAddChoice;
  /** Put the new journey on the page. Default `true`. */
  select?: boolean | undefined;
  /**
   * Runs the catalog write that adds the journey (its one synchronous step, after the designer
   * has loaded), so an agent's writing flag is up exactly while the mode writes and down across
   * the await. Must run `step` at once, once. Absent: the write runs as is.
   *
   * @internal
   */
  around?: ((step: () => void) => void) | undefined;
}

export interface JourneyBuilderMode extends BuilderMode {
  /**
   * The definition's `journey` block as edited: the value given, as given, object or not
   * (`null` from a store, say), until the first edit; after it, `undefined` once it says
   * nothing. Assigning starts over on another block.
   */
  journeyConfiguration: JourneyConfiguration | undefined;
  /** Starts over on another definition's block (Open form file, New form): every designer is dropped. */
  reseed(configuration: unknown): void;
  /** The journeys listed: usable ones, the first with each id. */
  readonly journeys: Journey[];
  /** The journey on the page; assigning puts another there. */
  journeyId: string | undefined;
  /** The journey on the page as it stands (committed edits; drafts wait for Save). */
  readonly journey: Journey | undefined;
  /** Whether the journey on the page has its designer built. */
  readonly ready: boolean;
  /**
   * What the canvas shows of the journey on the page (the bar's Map | Step); `"map"` while there
   * is none, and by default. Anything else assigned (`"pages"` once was a view) reads as `"map"`;
   * a journey with no step shows its map.
   */
  view: JourneyModeView;
  /**
   * How the Map view draws the journey: `direction` down or right. Remembered per
   * viewer, never in the definition, where the host remembers panels (`persist-panels`).
   * Assigning anything else keeps the direction; a map on the page is drawn again, fitted.
   */
  mapLayout: JourneyMapLayout;
  /** The runtime the journey runs on while Try it runs it; `undefined` otherwise, and while its chunk loads. */
  readonly previewRuntime: JourneyPreviewRuntime | undefined;
  /** Try it in the Journeys workspace: the journey's session, the Journey card and its actions. */
  readonly tryIt: BuilderModeTryIt;
  /** What the form opens as where the host names nothing: `opensAs`, else a journey whenever there is one. */
  readonly opensAs: JourneyOpensAs;
  selectJourney(id: string): Promise<void>;
  /** A new journey, made from the form (the designer is loaded for it), added and by default put on the page. */
  newJourney(options: NewJourneyOptions): Promise<Journey>;
  addJourney(journey: Journey, options?: { select?: boolean | undefined }): void;
  replaceJourney(id: string, journey: Journey): void;
  /**
   * The journey under another name; the id stays. An empty name is no name. `name` is the
   * default-language string; the name's translations stay as they are.
   */
  renameJourney(id: string, name: string): void;
  duplicateJourney(id: string, options?: DuplicateJourneyOptions & { select?: boolean | undefined }): Journey;
  /** Removes the journey; the form may be left with none. */
  removeJourney(id: string): void;
  setDefaultJourney(id: string): void;
  /** Writes `opensAs` (a catalog action, reported as `"journeys"`); `"journey"` removes the key unless the block given wrote it. */
  setOpensAs(value: JourneyOpensAs): void;
  /**
   * Makes the form open as the journey `id`, or as the whole form for `"form"`: the
   * default journey and `opensAs` together, one catalog change reported as `"journeys"`. What the
   * documents menu's "Set as default" does.
   */
  chooseOpensAs(id: string): void;
  /**
   * Writes `next` as the catalog, the way every catalog action commits (one change reported as
   * `"journeys"`, about the journey `subjectId` when it is listed): an agent's undo of its own
   * catalog action, computed from the catalog as it stands. Designers follow
   * the change as for any catalog action and keep their histories, the person's included; never
   * the reseeding {@link journeyConfiguration} setter, which starts every designer over. The page
   * keeps the journey it shows unless `next` no longer lists it. `next` is copied, never kept.
   * No step of the form's history, unless translations move with it (a journey taken away or
   * brought back): then one step holds the change and its wording.
   *
   * @internal
   */
  applyCatalogForAgent(next: JourneyConfiguration | undefined, subjectId: string | undefined): void;
  /**
   * Opens the add popover (what an overview's New and "New journey…" do), under `anchor` when
   * given; `options` as the shell's add passes them.
   */
  openAdd(anchor?: HTMLElement, options?: BuilderModeAddOptions): Promise<void>;
  /**
   * "Ask it here": puts the form component the journey on the page asks nowhere
   * onto its last page that every path takes (a one-page journey's only page, when no condition
   * holds it back), else onto one new page where every path reaches it — so its Required is
   * never relaxed by the path — as one undo entry, through the
   * unsaved-edits prompt. Whether it was placed now.
   */
  askUnassigned(componentId: string): Promise<boolean>;
  /**
   * "Make it optional on the form": selects the form component on the Form tab, so
   * the author changes its Required there; nothing is edited for them.
   */
  openFormComponent(componentId: string): void;
  /**
   * "Ask differently here…": the form field the journey on the page reuses at
   * `nodeId` (a question, at the top of a page or inside a layout of its own) is replaced in its
   * place by a page-only field of the same type that fills it, its label, help and options
   * copied, under a fresh id — one undo entry, through the unsaved-edits prompt — and that field
   * is selected, to be worded differently. Whether it was replaced now.
   */
  askDifferently(nodeId: string): Promise<boolean>;
  /**
   * Not on the bar (the Form fields panel places a field on the step shown, and a required
   * field's finding offers "Ask it here"); kept as the mode's API.
   * Puts what the journey on the page asks on no page onto the selected page (or the page
   * holding the selection) unless it is an exit page, else onto one new page at the end — one
   * undo entry. A one-page journey's go onto its one page whatever is selected, before its
   * closing buttons: it stays one page unless the author adds a page. Whether
   * anything was placed now (`false` too when the unsaved-edits prompt holds it).
   */
  addUnassigned(): Promise<boolean>;
  /**
   * Not on the bar (each such question's finding offers "Remove"); kept as the mode's API. Takes the questions whose form component the form no longer has off the journey on the
   * page — one undo entry, through the unsaved-edits prompt. Whether anything was removed now
   * (`false` too when the prompt holds it).
   */
  removeMissing(): Promise<boolean>;
  /**
   * Every journey's texts for the Languages workspace (`BuilderMode.translatableTexts`): names,
   * wording and page titles, then each page's own nodes' texts, written or not, each with its
   * default-language string and the address its translations live at in the definition's map
   * (`journeys › <journeyId> › …`; a page-only node's under its own id). Grouped
   * `journey.<journeyId>[.<pageId>]`. `words` are the builder's own words for the rows' labels
   * (English when absent).
   */
  translatableTexts(words?: BuilderTextOptions): TranslatableText[];
  /**
   * The journeys' block as a document the form's history can read and rewrite: the
   * texts it holds with their defaults, and a writer for new defaults (Make default changes them
   * together with the map, in one undo step). The block holds no translations, so a language
   * removed or renamed never touches it (`BuilderController.setOutsideDocuments`).
   */
  localeDocument(): OutsideDocument;
}

/**
 * The mode's own chrome: the bar's Map | Step switch. The designer's popover, empty state and map
 * bring their own once loaded; the Journey card wears the Try panel's own card styles.
 */
export const JOURNEY_BUILDER_MODE_STYLES = `
  /* What the canvas shows while the flow map's chunk loads. */
  .journey-load-note { margin: var(--db-space-6) auto; max-width: min(420px, calc(var(--db-shell-w, 100vw) - 32px)); color: var(--db-ink-muted); font-size: var(--db-text-sm); text-align: center; }
`;

/** How long a request for the Logic editor waits for a surface that is still loading. */
const LOGIC_REQUEST_LIFE_MS = 10_000;

/** The id of the Step view inspector's "Ask differently here…" (`data-inspector-mode-action`). */
export const ASK_DIFFERENTLY_ACTION = "ask-differently";

/** A worked-out value's expression, on the Rules tab: stored as the node's `value`. */
const WORKED_OUT_RULES: readonly RuleDescriptor[] = [
  {
    key: "value",
    label: "Worked out as",
    description:
      "Worked out in the browser from this page's own fields, whenever one changes, into the form field the value names; the server checks the result with that field's own rules.",
    kind: "value",
    target: { propertyPath: "value" }
  }
];

const NO_RULES: readonly RuleDescriptor[] = [];

/** The designer's own node types and a reference: everything else on a journey's tree is a node of the journey's own. */
function isOwnType(type: string): boolean {
  return type !== JOURNEY_ROOT_TYPE && type !== JOURNEY_PAGE_TYPE && type !== JOURNEY_ROUTE_TYPE && type !== JOURNEY_FIELD_TYPE && type !== PRESENTATION_REFERENCE_TYPE;
}

/** The tree the controllers hold before a journey is built on them: a journey with no pages, and no palette. */
function idleRoot(): ComponentNode {
  return { id: JOURNEY_ROOT_ID, type: JOURNEY_ROOT_TYPE, configuration: {}, children: { [JOURNEY_PAGES_SLOT]: [] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether focus is on `element` or inside it, as its own document or shadow root sees it. */
function holdsFocus(element: HTMLElement): boolean {
  const active = (element.getRootNode() as Document | ShadowRoot).activeElement;
  return active !== null && active !== undefined && element.contains(active);
}

/**
 * Where focus goes once a node of the tree `before` is deleted, as `after` stands (WCAG 2.4.3): the node now in its place, else the one before it, else what held it —
 * its page, or the journey. `undefined` when nothing was deleted.
 */
export function journeyNodeAfterRemoval(before: ComponentNode, after: ComponentNode): string | undefined {
  const kept = new Map<string, ComponentNode>();
  const index = (node: ComponentNode): void => {
    kept.set(node.id, node);
    for (const child of Object.values(node.children ?? {}).flat()) {
      index(child);
    }
  };
  index(after);
  const find = (node: ComponentNode): string | undefined => {
    for (const [slotId, children] of Object.entries(node.children ?? {})) {
      for (const [at, child] of children.entries()) {
        if (!kept.has(child.id)) {
          const left = kept.get(node.id)?.children?.[slotId] ?? [];
          return (left[at] ?? left[at - 1])?.id ?? node.id;
        }
        const found = find(child);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return kept.has(before.id) ? find(before) : undefined;
}

/**
 * `journey` with its page heading hidden, the key where the builder's tree writes it
 * (after `progress`, before `offPathValues`; unknown keys, then `pages`, last), so the journey
 * reads back unchanged.
 */
function withHeadingHidden(journey: Journey): Journey {
  const { id, name, progress, offPathValues, validation, texts, pages, ...rest } = journey;
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(progress !== undefined ? { progress } : {}),
    heading: "hidden",
    ...(offPathValues !== undefined ? { offPathValues } : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(texts !== undefined ? { texts } : {}),
    ...rest,
    pages
  };
}


/** How many pruned subtrees the mode holds against an Undo (see `JourneyBuilderModeImpl.pruned`). */
const PRUNED_KEPT = 200;

/** A key for a text address or a prefix of one, for the maps that remember them. */
function addressKey(address: TextAddress | TranslationPrefix): string {
  return JSON.stringify([address.kind, address.owner ?? null, ...(address.path ?? [])]);
}

/** Whether `address` is the prefix itself or below it. */
function underPrefix(address: TextAddress, prefix: TranslationPrefix): boolean {
  const path = prefix.path ?? [];
  return address.kind === prefix.kind && address.owner === prefix.owner && path.every((segment, at) => address.path[at] === segment);
}

/** The ids of every node of a form's tree. */
function formIdsOf(root: ComponentNode): Set<string> {
  const ids = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    ids.add(node.id);
    for (const held of Object.values(node.children ?? {})) {
      stack.push(...held);
    }
  }
  return ids;
}

/** One journey's editing state: its controller, the designer over it, and what it last reported. */
interface JourneyEntry {
  id: string;
  controller: BuilderController;
  design?: JourneyEntryDesign | undefined;
  /** Page node id -> the page id it was last read or written as (`journey-tree.ts`). */
  pageIds: Map<string, string>;
  /** Route node id -> the page node it was found to go to by an id (`journey-tree.ts`). */
  routeLinks: Map<string, string>;
  /** Question node id -> the reference it was read from, as written (`journey-tree.ts`). */
  references: Map<string, Record<string, unknown>>;
  built: boolean;
  /** Set while the mode follows a rename of a node of the journey's own into its tree, so the follow-up is written with the rename, as one change. */
  following: boolean;
  /** Set while the controller is being built, so its own `init` is not an edit. */
  building: boolean;
  /** What Try it runs of this designer: one per build, so a designer built again starts the journey over. */
  previewSubject?: JourneyPreviewSubject | undefined;
  /** What the flow map draws of this designer: one per build, so a designer built again is drawn afresh. */
  mapSubject?: JourneyMapSubject | undefined;
  /** The Step view over this journey's controller: made when it is first shown, dropped with the designer. */
  step?: JourneyStepView | undefined;
  /** The journey as last reported, so a change that left it as it was (a draft keystroke) is not reported again. */
  reportedJson?: string | undefined;
  /** Each page node of the journey as last reported, with the page id it was written under: what a page rename is told by. */
  reportedPages?: ReadonlyArray<readonly [string, string]> | undefined;
  /** Why the tree last could not be written, so it is said once, not on every change. */
  lastProblem?: string | undefined;
  /** The tree as the last change left it: what a deletion is measured against, for where focus goes. */
  lastRoot?: ComponentNode | undefined;
  /** The builder's words the palette was last worded in, so a change of either relabels it (`JourneyDesigner.relabel`). */
  paletteWords?: { locale: string | undefined; catalog: BuilderTextCatalog | undefined } | undefined;
  unsubscribe: () => void;
}

/**
 * One Try it in the Journeys workspace: the session the canvas holds, over the
 * journey once its chunk is in (`journey`) and over the canvas's own preview until then.
 */
interface JourneyTryRun extends BuilderTrySession {
  readonly journey: JourneyPreviewSession | undefined;
  /** The Try panel was drawn: the Journey card's map goes into its kept slot. */
  drawn(panel: HTMLElement): void;
  /** The journey or the form it reads changed: the card's map draws again, once this change is done (`subject` absent: the form changed). */
  refreshMap(subject?: JourneyMapSubject, live?: boolean): void;
  /** The journey is on its way: the chunk is loading, or the designer building. */
  readonly pending: boolean;
  /** Runs the journey now on the page: started once it is built, shown afresh when its designer was built again. */
  follow(): void;
  /** The journey's page id for the node the preview runs a page under (Record, Assert this); `undefined` for no page node. */
  pageIdOf(runtimePageId: string): string | undefined;
}

/**
 * Each page node of a designer tree with the id its page is written under, in order: `journey`
 * is that tree as `journeyFromTree` wrote it, one page per page node. Empty when the two do not
 * line up, so nothing is read as a rename then.
 */
function writtenPages(tree: ComponentNode, journey: Journey): Array<readonly [string, string]> {
  const nodes = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).filter((node) => node.type === JOURNEY_PAGE_TYPE);
  const pages = journey.pages ?? [];
  return nodes.length === pages.length ? nodes.map((node, at) => [node.id, (pages[at] as { id: string }).id] as const) : [];
}

/**
 * The pages of a journey whose id one edit changed: the same page node (or the node `renamed`
 * gave a new id) written under another id, the old id gone from the journey and the new one not
 * in it before. A page added or deleted, or two ids swapped, is no rename.
 */
function pageRenames(
  before: ReadonlyArray<readonly [string, string]> | undefined,
  after: ReadonlyArray<readonly [string, string]>,
  renamed: { from: string; to: string } | undefined
): Array<{ from: string; to: string }> {
  if (!before || before.length === 0) {
    return [];
  }
  const was = new Map(before);
  const idsBefore = new Set(before.map(([, pageId]) => pageId));
  const idsAfter = new Set(after.map(([, pageId]) => pageId));
  const found: Array<{ from: string; to: string }> = [];
  for (const [nodeId, pageId] of after) {
    const old = was.get(nodeId) ?? (renamed !== undefined && renamed.to === nodeId ? was.get(renamed.from) : undefined);
    if (old !== undefined && old !== pageId && !idsAfter.has(old) && !idsBefore.has(pageId)) {
      found.push({ from: old, to: pageId });
    }
  }
  return found;
}

/** The page nodes of the journey a Try it runs, in order. */
function tryPageNodes(subject: JourneyPreviewSubject): ComponentNode[] {
  return (subject.tree().children?.[JOURNEY_PAGES_SLOT] ?? []).filter((node) => node.type === JOURNEY_PAGE_TYPE);
}

/** A page node's id as the journey is written (its `pageId`, else the id it was last written as, else its node id), never the node id the preview runs it under. */
function tryPageIdOf(subject: JourneyPreviewSubject, node: ComponentNode): string {
  const own = (node.configuration as { pageId?: unknown } | undefined)?.pageId;
  return typeof own === "string" && own.trim() !== "" ? own : (subject.pageIds.get(node.id) ?? node.id);
}

/** The shell's canvas panel, as Try it reaches it: duck-typed, its module being the shell's. */
type TryCanvas = HTMLElement & {
  previewing?: boolean;
  /** The selection bar's actions on the selected node, the Delete's confirmation included (the command palette's way in). */
  runAction?(action: "up" | "down" | "move" | "duplicate" | "logic" | "delete"): void;
  tryRefresh?(): void;
  previewRoot?(): ShadowRoot | undefined;
  previewRuntime?(): RenderHostRuntime | undefined;
};

/**
 * What stands in for the Journey card while the try session's chunk is still coming: a line, not
 * a card, since the panel's card markup is the lazy chunks' alone (`check-bundles`).
 */
const TRY_LOADING_CARD = `<p class="try-note" role="status" data-try-journey-loading>Starting the journey…</p>`;

/** The Journey card's node the map stands in (`journey-preview.ts` writes it, the Try panel keeps it): empty in the markup, filled by the mode. */
const TRY_MAP_SLOT = "data-try-journey-map";

class JourneyBuilderModeImpl implements JourneyBuilderMode {
  public readonly id = JOURNEY_BUILDER_MODE;
  public readonly label = "Journeys";
  public readonly variables = "conditions" as const;
  public readonly inspector: { rules: BuilderModeRules; settingsLabel: string };
  public readonly documents: BuilderDocuments;
  public readonly formSettings: BuilderFormSettings;
  public readonly tryIt: BuilderModeTryIt;

  private readonly options: JourneyBuilderModeOptions;
  private readonly model: JourneyModeModel;
  private readonly entries = new Map<string, JourneyEntry>();
  /**
   * Translations pruned with a journey, page or page-only node, by the prefix they lived under
   * (`translationsKey`), kept until the edit is taken back: an Undo in the designer brings the
   * page back, and its entries with it. Another definition empties it.
   */
  private readonly pruned = new Map<string, Array<{ locale: string; address: TextAddress; entry: TranslationEntry }>>();
  /** What the panels point at while the form has no journey: an empty journey, no palette. */
  private readonly idleController = new BuilderController({ componentTypes: [], initialRoot: idleRoot() });
  private readonly listeners = new Set<() => void>();
  private readonly settingsListeners = new Set<() => void>();
  private designer: JourneyDesigner | undefined;
  private context: BuilderModeContext | undefined;
  private active = false;
  /** Whether anything was edited since the block was given: until then, the block is reported as given. */
  private edited = false;
  /**
   * The definition's `journey` value as given, object or not: the model reads anything but an
   * object as none, and a definition read back unedited must still carry the value it had.
   */
  private given: unknown;
  /** The block given wrote `opensAs: "journey"`, so choosing the journey writes it back rather than removing the key. */
  private seedOpensAsJourney = false;
  /** Set while the mode pushes an edit into an open tree itself (a rename), so the tree's own change is not reported twice. */
  private syncing = false;
  /** The form's committed tree, read once per form change. */
  private formRootMemo: ComponentNode | undefined;
  /** Which form components a condition may read, per form change. */
  private readableMemo: Set<string> | undefined;
  private documentsSignature = "";
  private settingsSignature = "";
  private readonly formOff: () => void;
  /** The Logic workspace's way to edit this mode's Go to rules (`logic-journey-host.ts`), registered under the form's controller. */
  private readonly logicOff: () => void;
  private readonly logicListeners = new Set<() => void>();
  private readonly logicOpenListeners = new Set<(request: LogicOpenRequest) => void>();
  /** What the Logic host last reported to its listeners, and the number it reads as its version. */
  private logicSeen: { configuration: unknown; ready: boolean } | undefined;
  private logicVersion = 0;
  private logicMemo: { configuration: unknown; journeys: Journey[] } | undefined;
  /** A request from the map made while no Logic surface was listening: held a few seconds for the one the workspace is loading. */
  private logicPending: { request: LogicOpenRequest; at: number } | undefined;

  private addHost: HTMLElement | undefined;
  private addPopover: JourneyAddPopover | undefined;
  /** How the add flow on the page was started, until it ends. */
  private addOptions: BuilderModeAddOptions | undefined;
  private emptyState: JourneyEmptyState | undefined;
  private viewsGroup: HTMLElement | undefined;
  private viewValue: JourneyModeView = "map";
  /** The step node the Step view opens on when it next goes up (the map's Open): taken once. */
  private stepAt: string | undefined;
  private readonly inspectionListeners = new Set<() => void>();
  private readonly findingsListeners = new Set<() => void>();
  private findingsSignature = "";
  private readonly fieldsListeners = new Set<() => void>();
  private fieldsSignature = "";
  private readonly historyListeners = new Set<() => void>();
  /** The form's steps made while a journey is on the page, reached from there ({@link formStepsOnPage}). */
  private readonly formSteps = formStepsOnPage(
    () => this.options.form,
    this.entries,
    this.historyListeners,
    () => this.model.configuration,
    (before, after) => this.blockCommand(before, after),
    () => this.active
  );
  /** Commits to the form's tree heard so far, and as of the form change last worked on: told apart from a draft's keystrokes (`onFormChange`). */
  private formMutations = 0;
  private formMutationsSeen = 0;
  private readonly formMutationOff: () => void;
  /** What makes the journey Try it runs, once its chunk is in; `tryLoad` while it is coming. */
  private tryMaker: JourneyTrySessionMaker | undefined;
  private tryLoad: Promise<JourneyTrySessionMaker> | undefined;
  /** The journey the chunk was last loaded ahead for: once per journey put on the page. */
  private tryWarmed: string | undefined;
  /** Try it's run while it is on in the Journeys workspace: the canvas holds it as its session. */
  private trying: JourneyTryRun | undefined;
  /** The flow map, once its chunk is in; `mapLoad` while it is coming. */
  private map: JourneyMap | undefined;
  private mapLoad: Promise<JourneyMap> | undefined;
  /** The load the canvas waits on to show the map, so its outcome is followed once. */
  private mapAwaited: Promise<JourneyMap> | undefined;
  private mapNote: HTMLElement | undefined;
  private mapLayoutValue: JourneyMapLayout = normalizeJourneyMapLayout(undefined);
  /** The `persist-panels` key the layout was last read under: read again only when it changes. */
  private mapPersistKey: string | undefined;
  /** The shell's root the link clicks are heard on (`onLinkClick`), while the mode is active. */
  private clickRoot: ShadowRoot | undefined;
  /** The move of focus being followed (`followFocus`): a later one takes over. */
  private focusToken: object | undefined;
  /** Whether the page-only fields' chunk is in: the journeys built after it offer and draw them. */
  private authoringReady = false;
  /** The try at the page-only fields' chunk under way, if any. */
  private authoringLoad: Promise<void> | undefined;
  /** The Rules tab's descriptors for each page-only type, kept so the tab never sees a new list for the same type. */
  private readonly ownRulesMemo = new Map<string, readonly RuleDescriptor[]>();
  private disposed = false;

  public textCatalog: (() => BuilderTextCatalog | undefined) | undefined;

  constructor(options: JourneyBuilderModeOptions) {
    this.options = options;
    this.textCatalog = options.textCatalog;
    this.given = options.journey;
    this.model = new JourneyModeModel(options.journey, options.journeyId);
    this.seedOpensAsJourney = isRecord(options.journey) && options.journey.opensAs === "journey";

    // Kept as one object: the inspector drops its rule edits in progress when it changes.
    const rules: BuilderModeRules = {
      // A page has no condition of its own (branching is a route's), and a route's condition is
      // edited in the Logic workspace's Go to rule, so neither has a Rules tab.
      descriptors: (nodeType) =>
        nodeType === PRESENTATION_VALUE_TYPE ? WORKED_OUT_RULES : isOwnType(nodeType) ? this.ownRules(nodeType) : NO_RULES,
      fieldOptions: (nodeId) => this.ruleFieldOptions(nodeId),
      formulaFields: (nodeId) => this.ruleFormulaFields(nodeId),
      // A step's Logic tab lists its Go to rules, each opened in the Logic editor.
      ways: (nodeId) => this.stepWays(nodeId),
      note: (nodeId) => {
        const type = this.builtEntry()?.controller.editedNode(nodeId)?.type;
        return type === PRESENTATION_VALUE_TYPE
          ? "A worked-out value reads the own fields of its page by their ids; the form's fields and other pages' are not available to it."
          : type !== undefined && isOwnType(type)
            ? "A page-only field's rule runs in the browser alone; it reads the form's answers and this journey's own fields by id."
            : "A journey's condition reads the form's answers by component id; row., ancestor. and host. paths are not available to it.";
      }
    };
    this.inspector = { rules, settingsLabel: "Journey" };

    // Try it runs the journey on the page; the Journey card leads the panel.
    this.tryIt = {
      session: (answers) => this.startTry(answers),
      cards: () => {
        const run = this.trying;
        return run?.journey ? run.journey.card() : run?.pending ? TRY_LOADING_CARD : "";
      },
      onTryClick: (action) => this.onTryClick(action),
      // The Journey card's map is made once and kept: the panel rewrites its markup on every draw.
      kept: [TRY_MAP_SLOT],
      drawn: (panel) => this.trying?.drawn(panel)
    };

    this.documents = {
      // The shell's words for a document here: "Add a journey", "Journey options".
      // One kind (no "form variant"), named so the palette says "New journey…".
      noun: "journey",
      addKinds: [{ id: "journey", noun: "journey" }],
      list: () => this.documentList(),
      selectedId: () => this.model.selected()?.id,
      select: (id) => this.selectJourney(id),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      // A designer that failed to load is reported by openAdd; the shell's + has nothing to add.
      add: (anchor, _kind, options) => this.openAdd(anchor, options).catch(() => undefined),
      // The popover and its styles come with the designer's chunk.
      prepareAdd: async () => {
        await this.ensureDesigner();
      },
      rename: (id, name) => this.guard("The journey could not be renamed", () => this.renameJourney(id, name)),
      duplicate: (id) => this.guard("The journey could not be copied", () => void this.duplicateJourney(id, { select: true })),
      remove: (id) => this.guard("The journey could not be removed", () => this.removeJourney(id)),
      // Making a journey the default makes the form open as it, else the mark the menu
      // then shows ("Default") would be a field nothing reads while the form opens whole.
      setDefault: (id) => this.guard("The journey could not be made the default", () => this.chooseOpensAs(id))
    };

    this.formSettings = {
      title: "Journeys",
      rows: () => this.settingsRows(),
      subscribe: (listener) => {
        this.settingsListeners.add(listener);
        return () => {
          this.settingsListeners.delete(listener);
        };
      }
    };

    this.formOff = options.form.on("change", (event) => this.onFormChange(event));
    this.formMutationOff = options.form.on("mutation", (event) => {
      this.formMutations += 1;
      // A form step made while a journey is on the page (a test removed, an edit in the Step view, whose own history is asked first).
      this.formSteps.heard(event);
    });
    this.logicOff = registerLogicJourneyHost(options.form, this.logicHost());
    // A presentation's own nodes keep their ids: the form neither makes one for a new
    // component nor renames one onto it, which would leave the own entry unusable (rule A).
    options.form.setOptions({ claimedIds: () => this.claimedOwnIds() }, { silent: true });
    this.documentsSignature = this.signatureOfDocuments();
    this.settingsSignature = this.signatureOfSettings();
  }

  // --- the mode contract --------------------------------------------------

  public get controller(): BuilderController {
    const selected = this.model.selected();
    return selected ? this.entryFor(selected.id).controller : this.idleController;
  }

  /** The bar's own control: Map | Step, drawn once there is a DOM to draw it in. */
  public get barActions(): HTMLElement[] {
    const views = this.ensureViewsGroup();
    return views ? [views] : [];
  }

  /** The add popover's host, appended to the shell's shadow root while the mode is on the page. */
  public get overlays(): HTMLElement[] {
    const host = this.ensureAddHost();
    return host ? [host] : [];
  }

  /** The bar's stylesheet; the designer's popover and empty state once it is loaded; the flow map's once it is. */
  public get styles(): string {
    return `${JOURNEY_BUILDER_MODE_STYLES}${this.designer?.panelStyles ?? ""}${this.map?.styles ?? ""}`;
  }

  public async activate(context: BuilderModeContext): Promise<void> {
    await this.ensureDesigner();
    this.context = context;
    this.active = true;
    this.readMapLayout(context);
    // While Try it runs the journey a link in the form is held, and its click composes out of the
    // renderer's shadow root: it is heard on the shell's.
    if (this.clickRoot !== context.root && typeof context.root?.addEventListener === "function") {
      this.unlistenClicks();
      this.clickRoot = context.root;
      this.clickRoot.addEventListener("click", this.onLinkClick);
    }
    this.ensureFresh();
    this.syncControls();
    this.applyView();
    this.announcePendingRenames();
  }

  public deactivate(): void {
    // The designers, their history and selection stay for the round trip back; so does the map,
    // which catches up when it is shown again. Try it ends with the workspace (the shell's).
    this.active = false;
    this.addPopover?.close();
    this.map?.hide();
    this.unlistenClicks();
    // The Step view goes down with the workspace: its one history stops hearing
    // the form, so an edit made in the Form or Logic workspace is the form's own step, never one
    // the Step view's Undo takes back. The step shown is kept; activating brings it up again.
    for (const entry of this.entries.values()) {
      entry.step?.leave();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.unlistenClicks();
    this.formOff();
    this.formMutationOff();
    this.logicOff();
    this.options.form.setOptions({ claimedIds: undefined }, { silent: true });
    for (const entry of this.entries.values()) {
      entry.step?.dispose();
      entry.unsubscribe();
    }
    this.entries.clear();
    this.addPopover?.close();
    // A map still loading is dropped when it arrives (ensureMap); a try run, when its chunk does.
    this.trying?.dispose();
    this.tryLoad = undefined;
    this.map?.dispose();
    this.map = undefined;
    this.mapLoad = undefined;
    this.active = false;
    this.context = undefined;
  }

  // --- the designer ---------------------------------------------------------

  private async ensureDesigner(): Promise<JourneyDesigner> {
    if (!this.designer) {
      await this.createDesigner();
    }
    const designer = this.designer as JourneyDesigner;
    // The page-only fields before any journey is built on it: a controller's types
    // are fixed when it is built. Without them a journey still opens; its own nodes are drawn as
    // types nothing knows, and the chunk is tried again on the next activation, `+` or journey
    // opened (`selectJourney`) — for the journeys built then. One try at a time, said once.
    if (!this.authoringReady) {
      this.authoringLoad ??= designer.loadAuthoring().then(
        () => {
          this.authoringReady = true;
          // The Go to rules in Logic become editable now.
          this.notifyLogic();
        },
        (error: unknown) => {
          this.authoringLoad = undefined;
          this.options.onError?.("The page-only fields could not load", error);
        }
      );
      await this.authoringLoad;
    }
    return designer;
  }

  private async createDesigner(): Promise<void> {
    let module: JourneyDesignerModule;
    try {
      module = await loadJourneyDesigner();
    } catch (error) {
      this.options.onError?.("The Journeys designer could not load", error);
      throw error;
    }
    if (!this.designer) {
      const isValueless = this.options.isValueless;
      this.designer = module.createJourneyDesigner({
        formRoot: () => this.formRoot(),
        locale: () => this.locale(),
        sources: () => this.sources(),
        textCatalog: () => this.textCatalog?.(),
        ...(isValueless ? { isValueless } : {}),
        formDefinitions: () => this.options.formDefinitions?.(),
        formTypes: () => this.options.form.componentTypes()
      });
      this.idleController.setOptions(this.designer.idleOptions(), { silent: true });
    }
  }

  // --- the catalog ------------------------------------------------------------

  public get journeyConfiguration(): JourneyConfiguration | undefined {
    return this.edited ? canonicalJourneyConfiguration(this.model.configuration) : (this.given as JourneyConfiguration | undefined);
  }

  public set journeyConfiguration(value: JourneyConfiguration | undefined) {
    this.reseed(value);
  }

  public reseed(configuration: unknown): void {
    this.model.reseed(configuration);
    this.pruned.clear();
    this.given = configuration;
    this.edited = false;
    this.seedOpensAsJourney = isRecord(configuration) && configuration.opensAs === "journey";
    // Another definition's journeys: every designer starts over.
    for (const entry of this.entries.values()) {
      entry.step?.dispose();
      entry.unsubscribe();
    }
    this.entries.clear();
    // Another definition: Try it ends, its journey dropped first, so none of the answers given to
    // the form it replaced are handed back to the canvas.
    if (this.trying) {
      this.trying.dispose();
      this.endTryIt();
    }
    if (this.active) {
      this.ensureFresh();
    }
    this.syncControls();
    this.applyView();
  }

  public get journeys(): Journey[] {
    return this.model.journeys;
  }

  public get journeyId(): string | undefined {
    return this.model.selected()?.id;
  }

  public set journeyId(value: string | undefined) {
    if (value === undefined) {
      this.model.journeyId = undefined;
      if (this.active) {
        this.ensureFresh();
      }
      this.syncControls();
      this.applyView();
      return;
    }
    void this.selectJourney(value);
  }

  public get journey(): Journey | undefined {
    return this.model.selected();
  }

  public get ready(): boolean {
    const selected = this.model.selected();
    return selected !== undefined && this.entries.get(selected.id)?.built === true;
  }

  public get view(): JourneyModeView {
    return this.viewValue;
  }

  public set view(value: JourneyModeView) {
    const next: JourneyModeView = value === "step" ? "step" : "map";
    if (next === this.viewValue) {
      return;
    }
    const go = (): void => {
      if (next === this.viewValue) {
        return;
      }
      this.viewValue = next;
      this.syncViews();
      this.applyView();
    };
    // Leaving the Step view takes the form field the inspector edits out of sight: through the
    // inspector's guard for its unsaved edits, as a move to another step is (Keep editing: the step stays).
    if (this.stepNow()) {
      this.holdForInspector(go);
    } else {
      go();
    }
  }

  public get mapLayout(): JourneyMapLayout {
    return { ...this.mapLayoutValue };
  }

  public set mapLayout(value: JourneyMapLayout) {
    const next = normalizeJourneyMapLayout({ ...this.mapLayoutValue, ...(isRecord(value) ? value : {}) });
    if (next.direction === this.mapLayoutValue.direction) {
      return;
    }
    this.mapLayoutValue = next;
    this.map?.setLayout(next);
    this.writeMapLayout();
  }

  public get previewRuntime(): JourneyPreviewRuntime | undefined {
    return this.trying?.journey?.runtime;
  }

  // The Step view's seams with the shell: what a form field placed on the shown step is edited as, and the one Undo.

  public inspection(): BuilderModeInspection | undefined {
    return this.stepNow()?.inspection();
  }

  public subscribeInspection(listener: () => void): () => void {
    this.inspectionListeners.add(listener);
    return () => {
      this.inspectionListeners.delete(listener);
    };
  }

  public inspectorActions(): readonly BuilderInspectorAction[] {
    const actions = this.stepNow()?.inspectorActions() ?? [];
    // A form field placed on the step may be asked in words of the journey's own:
    // "Ask differently here…" beside "Take it off this step", where the cards offered it.
    const entry = this.builtEntry();
    const selected = entry?.controller.selectedComponentId();
    if (actions.length === 0 || !entry || !this.designer || selected === undefined) {
      return actions;
    }
    const tree = entry.controller.snapshot();
    const offered = entry.controller.componentTypes().map((type) => type.type);
    const label = this.designer.askDifferentlyLabel(tree, selected, entry, offered);
    if (label === undefined) {
      return actions;
    }
    return [
      ...actions,
      {
        id: ASK_DIFFERENTLY_ACTION,
        label,
        run: () => void this.askDifferently(selected).catch((error: unknown) => this.options.onError?.("The field could not be asked differently", error))
      }
    ];
  }

  /**
   * The Step view's history, then the form's steps made while the journey is on the page
   * ({@link formSteps}) while one of those is live. The Step view's holds every form step made
   * while it is up, so it goes first.
   */
  public history(): BuilderModeHistory | undefined {
    return this.formSteps.after(this.stepNow()?.history());
  }

  public subscribeHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  // The Journey panel's findings card and the Form fields panel.

  /**
   * What the journey on the page needs put right: its check's findings, errors first, with the
   * fixes the card offers. Empty while there is no built journey (the card is not drawn).
   */
  public findings(): readonly BuilderModeFinding[] {
    const entry = this.builtEntry();
    const designer = this.designer;
    if (!entry?.design || !designer) {
      return [];
    }
    return designer.findingEntries(entry.design.view()).map((found) => ({
      id: found.id,
      severity: found.severity,
      message: found.message,
      ...(found.nodeId !== undefined ? { select: () => void entry.controller.requestSelect(found.nodeId as string) } : {}),
      fixes: found.fixes.map((fix) => ({ id: fix.kind, label: fix.label, run: () => this.runFix(entry, fix) }))
    }));
  }

  /**
   * The Journey panel's "The form opens as": the whole form or
   * one of the journeys by name, committed as chosen (`chooseOpensAs`), as the documents menu's
   * Set as default is; the Form panel's row reads and writes the same values. None while no
   * journey is built.
   */
  public rootChoices(): readonly BuilderModeChoice[] {
    const journeys = this.model.journeys;
    if (journeys.length === 0 || !this.builtEntry()) {
      return [];
    }
    const locale = this.locale();
    const catalog = this.sources();
    const whole = wholeFormValue(journeys);
    const words = this.words();
    return [
      {
        id: "journeys.opensAs",
        label: builderText("journey.mode.opensAs.label", undefined, words),
        choices: [{ value: whole, label: builderText("journey.mode.opensAs.whole", undefined, words) }, ...journeys.map((journey) => ({ value: journey.id, label: journeyLabel(journey, locale, catalog) }))],
        value: () => (this.opensAs === "form" ? whole : (this.model.journeys.find((journey) => journey.id === this.model.defaultId) ?? this.model.journeys[0])?.id ?? whole),
        choose: (value) => this.guard("What the form opens as could not be set", () => this.chooseOpensAs(value === whole ? "form" : value))
      }
    ];
  }

  public subscribeFindings(listener: () => void): () => void {
    this.findingsListeners.add(listener);
    return () => {
      this.findingsListeners.delete(listener);
    };
  }

  /** One fix of a finding: the same writes the cards' fix-its made, each one undo step; "fill" only selects. */
  private runFix(entry: JourneyEntry, fix: JourneyFindingFix): void {
    const failed = (what: string) => (error: unknown) => this.options.onError?.(what, error);
    if (fix.kind === "ask" && fix.componentId !== undefined) {
      void this.askUnassigned(fix.componentId).catch(failed("The question could not be added"));
    } else if (fix.kind === "optional" && fix.componentId !== undefined) {
      this.openFormComponent(fix.componentId);
    } else if (fix.kind === "remove" && fix.nodeId !== undefined) {
      entry.controller.requestRemoveComponents([fix.nodeId]);
    } else if (fix.kind === "questions" && fix.nodeId !== undefined) {
      entry.controller.setProperty(fix.nodeId, "kind", "");
    } else if (fix.kind === "fill" && fix.nodeId !== undefined) {
      // The field of the journey's own whose answer goes nowhere, selected with its "Fills form
      // field" box focused in its inspector once the inspector shows it.
      const nodeId = fix.nodeId;
      if (entry.controller.requestSelect(nodeId)) {
        this.followFocus(
          (active) => active === null || active?.closest?.("[data-mode-findings]") != null,
          () => this.fillsBox()
        );
      }
    } else if (fix.kind === "move-end" && fix.nodeId !== undefined) {
      // A Check answers step to the end of the steps, in one undo step: the gap after the last.
      const tree = entry.controller.snapshot();
      entry.controller.requestMove(fix.nodeId, { parentId: tree.id, slotId: JOURNEY_PAGES_SLOT, index: (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).length });
    }
  }

  /**
   * The Form fields panel: offered while the Step view is up, listing the form's fields with
   * where the journey asks each; a click or a drag from it places the field on the step shown.
   */
  public readonly formFields: BuilderModeFormFields = {
    offered: () => this.stepNow() !== undefined,
    rows: () => this.fieldRows(),
    refusal: () => this.placeRefusal(),
    add: (componentId) => this.placeOnShownStep(componentId),
    // A drop on the canvas makes the placement as the palette's Form field does: the canvas's own drop of that type.
    drag: (componentId) =>
      this.stepNow() !== undefined && componentId !== "" && this.placeRefusal() === undefined ? { type: JOURNEY_FIELD_TYPE, configuration: { componentId } } : undefined,
    subscribe: (listener) => {
      this.fieldsListeners.add(listener);
      return () => {
        this.fieldsListeners.delete(listener);
      };
    }
  };

  private fieldRows(): readonly BuilderModeFormFieldRow[] {
    const entry = this.builtEntry();
    const designer = this.designer;
    const step = this.stepNow();
    if (!entry?.design || !designer || !step) {
      return [];
    }
    return designer.fieldRows(entry.design.view(), step.shown(), entry.id);
  }

  /** Why the step shown takes no form field (a Check answers or an exit step), worded; `undefined` when it takes them. */
  private placeRefusal(): string | undefined {
    const entry = this.builtEntry();
    const shown = this.stepNow()?.shown();
    return entry && this.designer && shown !== undefined ? this.designer.placeRefusal(entry.controller.snapshot(), shown) : undefined;
  }

  /** One placement of `componentId` on the step shown, in one undo step, through the unsaved-edits guard. */
  private placeOnShownStep(componentId: string): boolean {
    const entry = this.builtEntry();
    const designer = this.designer;
    const shown = this.stepNow()?.shown();
    if (!entry || !designer || shown === undefined || componentId === "" || this.placeRefusal() !== undefined) {
      return false;
    }
    // On this step already: shown as such in the panel, and never placed twice.
    if (this.fieldRows().some((row) => row.id === componentId && row.where === "here")) {
      return false;
    }
    const controller = entry.controller;
    let placed = false;
    // The step's own Undo: one entry on the journey's controller, which the Step view's history orders with the form's.
    controller.requestInsertComponents(() => designer.placeEntries(controller.snapshot(), componentId, shown, entry.pageIds, entry.references), {
      select: "none",
      onResult: (result) => {
        placed = result.ok && result.ids.length > 0;
      }
    });
    return placed;
  }

  /** The panels the mode feeds read what moved: told once each, only when what they would draw changed. */
  private syncPanels(): void {
    this.notifyFindings();
    this.notifyFields();
  }

  private notifyFindings(): void {
    if (this.findingsListeners.size === 0) {
      return;
    }
    const signature = JSON.stringify([
      this.findings().map((found) => [found.id, found.severity, found.message, found.select !== undefined, found.fixes.map((fix) => [fix.id, fix.label])]),
      this.rootChoices().map((choice) => [choice.id, choice.label, choice.choices, choice.value()])
    ]);
    if (signature === this.findingsSignature) {
      return;
    }
    this.findingsSignature = signature;
    for (const listener of [...this.findingsListeners]) {
      listener();
    }
  }

  private notifyFields(): void {
    if (this.fieldsListeners.size === 0) {
      return;
    }
    const signature = JSON.stringify([this.formFields.offered(), this.stepNow()?.shown() ?? null, this.fieldRows(), this.placeRefusal() ?? null]);
    if (signature === this.fieldsSignature) {
      return;
    }
    this.fieldsSignature = signature;
    for (const listener of [...this.fieldsListeners]) {
      listener();
    }
  }

  public get opensAs(): JourneyOpensAs {
    return this.model.configuration?.opensAs ?? (this.model.journeys.length > 0 ? "journey" : "form");
  }

  /**
   * Puts the journey on the page (built at once while the mode is active); an unknown id throws.
   * One not built yet waits for the page-only fields' chunk when its last try failed:
   * tried again first, so the journey is built with them if it comes.
   */
  public selectJourney(id: string): Promise<void> {
    const journey = this.model.require(id);
    if (this.model.selected()?.id !== id) {
      this.model.journeyId = id;
      this.options.onSelect?.({ journeyId: id, journey });
    }
    const show = (): void => {
      if (this.active) {
        this.ensureFresh();
      }
      this.syncControls();
      this.applyView();
    };
    if (this.active && this.designer && !this.authoringReady && !this.entries.get(id)?.built) {
      return this.ensureDesigner().then(show);
    }
    show();
    return Promise.resolve();
  }

  public async newJourney(options: NewJourneyOptions): Promise<Journey> {
    const designer = await this.ensureDesigner();
    const typed = (options.name ?? "").trim();
    const select = options.select !== false;
    if (options.from === "copy") {
      const current = this.model.selected();
      if (!current) {
        throw new Error("There is no journey to copy");
      }
      const copyOptions = {
        select,
        ...(typed !== "" ? { name: typed, id: uniqueJourneyId(journeyIdFromName(typed), takenJourneyIds(this.model.configuration)) } : {})
      };
      const around = options.around;
      if (!around) {
        return this.duplicateJourney(current.id, copyOptions);
      }
      let copied: Journey | undefined;
      around(() => {
        copied = this.duplicateJourney(current.id, copyOptions);
      });
      if (!copied) {
        throw new Error("The journey was not copied");
      }
      return copied;
    }
    // Spelled out rather than `isOnePageShape`, which lives in the designer's lazy chunk.
    const shape = options.from;
    const onePage = shape === "one-page" || shape === "questions-one-page";
    const name = typed !== "" ? typed : this.defaultNewName();
    const id = uniqueJourneyId(journeyIdFromName(name), takenJourneyIds(this.model.configuration));
    // A one-page start looks like the form: its page titled as the form,
    // and its page heading hidden, so the form's title heads it as it heads the whole form.
    const title = onePage ? this.formTitle() : undefined;
    // The pages titled from a text of the form (a section's label, the form's title) are
    // carried their translations once the journey is added.
    const titleOrigins: Array<{ pageId: string; from: TextAddress }> = [];
    // A new journey is one empty step with no fields: its required
    // fields are the findings it starts with, and the Form fields panel puts them on steps. The
    // form's shapes stay for a caller that names one (an agent's tool).
    const made =
      shape === "blank"
        ? designer.blank({ id, name })
        : designer.fromForm({
            id,
            name,
            shape,
            ...(title !== undefined ? { title, titleFrom: addressOf.form("title") } : {}),
            titleOrigins
          });
    const journey = onePage ? withHeadingHidden(made) : made;
    const add = (): void => {
      // A new journey opens on its map, whatever its number of steps.
      if (select) {
        this.viewValue = "map";
      }
      this.addJourney(journey, { select }, this.titleCarry(journey, titleOrigins));
    };
    if (options.around) {
      options.around(add);
    } else {
      add();
    }
    return journey;
  }

  // Every catalog action is one step of the form's history, its translations
  // rewrite included: each runs as one `formSteps.stepped` run.

  /** One step of the form's history; `also` rewrites the map in the same step (a new journey's titles carrying the form's wording). */
  public addJourney(journey: Journey, options: { select?: boolean | undefined } = {}, also?: (map: FormTranslations) => FormTranslations): void {
    this.formSteps.stepped(() => {
      const blockBefore = this.model.configuration;
      this.applyConfiguration(addJourney(this.model.configuration, journey), journey, "journeys", options.select ? journey.id : undefined);
      // A journey that comes back (an agent taking its removal back) has its translations back.
      this.followTranslations(undefined, journey, {}, { before: blockBefore, also });
    });
  }

  public replaceJourney(id: string, journey: Journey): void {
    const before = this.model.require(id);
    const onPage = this.model.selected()?.id === id;
    this.formSteps.stepped(() => {
      this.applyConfiguration(replaceJourney(this.model.configuration, id, journey), journey, "journeys", onPage && journey.id !== id ? journey.id : undefined);
      // Another id moves the journey's translations; pages or nodes the host dropped prune theirs.
      this.followTranslations(before, journey);
      // A host that gives a journey another id (the one place an id changes): told after the change, for the Tests to follow.
      const ids = this.model.journeys.map((listed) => listed.id);
      if (journey.id !== id && ids.includes(journey.id) && !ids.includes(id)) {
        this.options.onChange?.({ journey, configuration: this.journeyConfiguration, reason: "journey-rename", renamed: { journeyId: journey.id, from: id, to: journey.id } });
        this.announceRename("journey", journey.id, id, journey.id);
      }
    });
  }

  public renameJourney(id: string, name: string): void {
    const journey = this.model.require(id);
    const typed = name.trim();
    const current = journey.name;
    const next: Journey = { ...journey };
    if (typed === "") {
      if (current === undefined) {
        return;
      }
      // Only the default string goes; the name's translations stay in the map, stale-flagged
      // against whatever default comes next.
      delete next.name;
    } else if (typed !== (current ?? "")) {
      // The box shows the name in the builder's locale, but what is typed is the default
      // string: translations are written in the Languages workspace and nowhere else.
      next.name = typed;
    } else {
      return;
    }
    this.replaceJourney(id, next);
  }

  public duplicateJourney(id: string, options: DuplicateJourneyOptions & { select?: boolean | undefined } = {}): Journey {
    const { select, ...rest } = options;
    const copied = duplicateJourney(this.model.configuration, id, rest);
    // The copy carries the original's translations under its own id; its name is
    // worded otherwise, so that entry reads as source-changed until the author confirms it. The
    // copy and its entries are one step of the form's history: one Undo takes both away.
    this.formSteps.stepped(() => {
      const blockBefore = this.model.configuration;
      this.applyConfiguration(copied.configuration, copied.journey, "journeys", select ? copied.journey.id : undefined);
      this.followTranslations(undefined, copied.journey, {}, { before: blockBefore, also: (map) => copyTranslations(map, "journeys", id, copied.journey.id) });
    });
    return copied.journey;
  }

  public removeJourney(id: string): void {
    const removed = this.model.require(id);
    const next = removeJourney(this.model.configuration, id);
    // The journey's translations go from every language with it, in the same step of
    // the form's history as the journey. Its designer goes too, its Step view with it: once
    // the entry is gone nothing else would release that view's listeners on the form.
    this.formSteps.stepped(() => {
      const entry = this.entries.get(id);
      if (entry) {
        entry.step?.dispose();
        entry.unsubscribe();
        this.entries.delete(id);
      }
      this.applyConfiguration(next, removed, "journeys", this.model.selected()?.id === id ? journeysOf(next)[0]?.id : undefined);
      this.followTranslations(removed, undefined);
    });
  }

  /**
   * The journeys' block as a document the form's history can rewrite: Make default
   * promotes a translation to be the default, and the journeys' default strings change with the
   * map in the same Undo step. The block holds no translations (they are the definition's map),
   * so a language removed or renamed never reaches it. Writing is the catalog's own action,
   * reported like any other (`"journeys"`), and not an edit of a designer's tree.
   */
  public localeDocument(): OutsideDocument {
    return {
      id: "journeys",
      read: () => this.model.configuration,
      write: (value) => this.rewriteDefaults(value as JourneyConfiguration | undefined),
      texts: () => this.translatableTexts().flatMap((row) => (row.address ? [{ address: row.address, default: row.default }] : [])),
      setDefaults: (value, edits) => setJourneyDefaults(value as JourneyConfiguration | undefined, edits)
    };
  }

  /** The catalog replaced by `next` with only its default strings changed; the journey that changed is the change's subject. */
  private rewriteDefaults(next: JourneyConfiguration | undefined): void {
    const configuration = this.model.configuration;
    const after = journeysOf(next);
    const changed = journeysOf(configuration).find((journey, index) => JSON.stringify(journey) !== JSON.stringify(after[index]));
    this.applyConfiguration(next, changed ?? this.model.selected(), "journeys");
  }

  // The default and what the form opens as: each one step of the form's history.
  public setDefaultJourney(id: string): void {
    this.formSteps.stepped(() => this.applyConfiguration(setDefaultJourney(this.model.configuration, id), this.model.require(id), "journeys"));
  }

  public setOpensAs(value: JourneyOpensAs): void {
    const written = value === "form" ? "form" : this.seedOpensAsJourney ? "journey" : undefined;
    if (this.model.configuration?.opensAs !== written) {
      this.formSteps.stepped(() => this.applyConfiguration(setOpensAs(this.model.configuration, written), undefined, "journeys"));
    }
  }

  public chooseOpensAs(id: string): void {
    const subject = id === "form" ? undefined : this.model.require(id);
    const next = chooseOpensAs(this.model.configuration, id);
    // Chosen again: nothing to write, nothing to report.
    if (JSON.stringify(next) !== JSON.stringify(this.model.configuration)) {
      this.formSteps.stepped(() => this.applyConfiguration(next, subject, "journeys"));
    }
  }

  /**
   * The catalog put back to `next` as an agent's undo computed it (see the interface).
   *
   * @internal
   */
  public applyCatalogForAgent(next: JourneyConfiguration | undefined, subjectId: string | undefined): void {
    const before = new Map(this.model.journeys.map((journey) => [journey.id, journey]));
    const block = { before: this.model.configuration };
    // Whatever steps this writes (only when wording moves) are one entry, held by the designer
    // on the page as a catalog step is: the bar's Undo there takes the restore back first.
    this.formSteps.joined(() => {
      this.putCatalog(next, subjectId);
      // A journey, page or node the change took away has its translations pruned, one it brought
      // back has them restored; that rewrite holds the catalog's change too, so its Undo takes back
      // the whole change (a restore), never the wording alone.
      const after = new Map(this.model.journeys.map((journey) => [journey.id, journey]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        this.followTranslations(before.get(id), after.get(id), {}, block);
      }
    });
  }

  /**
   * The catalog put to `next` as it stands, with nothing done to the translations: the agent's
   * undo ({@link applyCatalogForAgent}) follows it with the entries' rule, and the form's own
   * history ({@link blockCommand}) carries the entries in its own step.
   */
  private putCatalog(next: JourneyConfiguration | undefined, subjectId: string | undefined): void {
    // A copy: the caller keeps what it stored (an undo's snapshot) as it was.
    const given = next === undefined ? undefined : (JSON.parse(JSON.stringify(next)) as JourneyConfiguration);
    const listed = journeysOf(given);
    // The page keeps the journey it shows; one the change takes away gives way to the first left, as a removal does.
    const shown = this.model.selected()?.id;
    const select = shown !== undefined && !listed.some((journey) => journey.id === shown) ? listed[0]?.id : undefined;
    const subject = subjectId === undefined ? undefined : listed.find((journey) => journey.id === subjectId);
    this.applyConfiguration(given, subject, "journeys", select);
  }

  /**
   * The journeys' block as a step of the form's history: composed with the
   * map's command by `BuilderController.rewriteTranslations`, so a journey or page removed or a
   * copy made is one Undo with its entries. The change is already applied when this is made, so
   * the first run does nothing; Undo and Redo put the block back as the step left it, carrying
   * just the step's change onto the block as it stands then (what the author did to another
   * journey since is kept). The entries held in {@link pruned} are not touched: a designer Undo
   * of the same removal writes entries only where the map lacks them, so the two never
   * double-restore.
   */
  private blockCommand(before: JourneyConfiguration | undefined, after: JourneyConfiguration | undefined): BuilderCommand {
    return appliedStep("JOURNEYS", before, after, () => this.model.configuration, carryJourneyBlock, (next) => {
      const wasListed = new Map(journeysOf(this.model.configuration).map((journey) => [journey.id, JSON.stringify(journey)]));
      const subject = journeysOf(next).find((journey) => wasListed.get(journey.id) !== JSON.stringify(journey)) ?? journeysOf(next)[0];
      this.putCatalog(next, subject?.id);
    });
  }

  public async openAdd(anchor?: HTMLElement, options: BuilderModeAddOptions = {}): Promise<void> {
    let designer: JourneyDesigner;
    try {
      designer = await this.ensureDesigner();
    } catch (error) {
      options.onEnd?.(undefined);
      throw error;
    }
    const host = this.ensureAddHost();
    if (!host) {
      options.onEnd?.(undefined);
      return;
    }
    this.addOptions = options;
    this.addPopover ??= designer.createAddPopover(host, {
      defaultName: () => this.defaultNewName(),
      // From an overview no journey is on the page, so there is none to copy.
      canCopy: () => !this.addOptions?.fromOverview && this.model.selected() !== undefined,
      questionCount: () => designer.questionCount(),
      onChoose: async (choice, name) => {
        let made: Journey;
        try {
          made = await this.newJourney({ name, from: choice });
        } catch (error) {
          this.options.onError?.("The journey could not be added", error);
          throw error;
        }
        const ended = this.addOptions?.onEnd;
        this.addOptions = undefined;
        ended?.(made.id);
        // Focus went down with the popover: it goes to the new journey's map, or its step's
        // sheet, once the canvas draws it. Only on the view it opened on: once the
        // author switches view, focus that falls with the map is not the popover's to place (a
        // script focus on the sheet then would draw its keyboard ring for a pointer's switch).
        const popover = this.addHost;
        const view = this.viewValue;
        this.followFocus(
          (active) => active === null || (popover !== undefined && popover.contains(active)),
          () => {
            const entry = this.builtEntry();
            if (entry?.id !== made.id || this.viewValue !== view) {
              return undefined;
            }
            // The Step view draws no box for the step: the sheet it is drawn on takes focus.
            if (this.stepNow()) {
              return this.canvas()?.shadowRoot?.querySelector<HTMLElement>(".canvas-page") ?? undefined;
            }
            // A new journey opens on its map: its one tab stop takes focus.
            return this.viewValue === "map" && this.map ? (this.map.element.querySelector<HTMLElement>('[data-map-item][tabindex="0"]') ?? undefined) : undefined;
          },
          80
        );
      }
    });
    this.addPopover.open(anchor, {
      onDismiss: () => {
        const ended = this.addOptions?.onEnd;
        this.addOptions = undefined;
        ended?.(undefined);
      }
    });
  }

  public async askUnassigned(componentId: string): Promise<boolean> {
    const designer = await this.ensureDesigner();
    const entry = this.builtEntry();
    if (!entry || componentId === "") {
      return false;
    }
    const controller = entry.controller;
    let placed = false;
    controller.requestInsertComponents(
      () => designer.addUnassignedEntries(controller.snapshot(), [componentId], undefined, entry.pageIds, "last", entry.references, entry.routeLinks),
      {
        select: "none",
        onResult: (result) => {
          placed = result.ok && result.ids.length > 0;
        }
      }
    );
    return placed;
  }

  /**
   * Tells the builder's shell a page or a journey took another id, so the form's
   * tests follow it without any host code: a bubbling, composed event on the root the mode already
   * uses for `builder-open-mode`. `onChange` keeps its own detail for hosts (`datum-journey-change`);
   * this is the shell's channel, because the `onChange` callback is the host's, not the shell's.
   */
  private announceRename(kind: "page" | "journey", journeyId: string, from: string, to: string): void {
    const root = this.context?.root;
    if (typeof root?.dispatchEvent === "function") {
      root.dispatchEvent(new CustomEvent("builder-journey-rename", { bubbles: true, composed: true, detail: { kind, journeyId, from, to } }));
    } else if (kind === "journey") {
      // A host's `replaceJourney` before the Journeys workspace was first opened: the shell's root
      // is not known yet, so the rename waits for `activate`. Page ids change only in the
      // designer, which runs with the mode active. A rename of a renamed journey goes on from the first one's old id.
      const chained = this.pendingRenames.find((renamed) => renamed.to === from);
      if (chained) {
        chained.journeyId = journeyId;
        chained.to = to;
      } else {
        this.pendingRenames.push({ journeyId, from, to });
      }
    }
  }

  /** Journey renames made before the mode had a root to tell; see {@link announceRename}. */
  private pendingRenames: Array<{ journeyId: string; from: string; to: string }> = [];

  /**
   * Tells the shell the journey renames that waited for a root, each only while it still holds
   * (the new id listed, the old one gone): another form opened since has journeys of its own.
   */
  private announcePendingRenames(): void {
    const pending = this.pendingRenames;
    if (pending.length === 0) {
      return;
    }
    this.pendingRenames = [];
    const ids = this.model.journeys.map((listed) => listed.id);
    for (const renamed of pending) {
      if (ids.includes(renamed.to) && !ids.includes(renamed.from)) {
        this.announceRename("journey", renamed.journeyId, renamed.from, renamed.to);
      }
    }
  }

  public openFormComponent(componentId: string): void {
    // The form's own selection first (through its unsaved-edits prompt, if any); then the
    // shell puts the Form tab on the page, whose inspector shows it (`builder-open-mode`).
    this.options.form.requestSelect(componentId);
    const root = this.context?.root;
    if (typeof root?.dispatchEvent === "function") {
      root.dispatchEvent(new CustomEvent("builder-open-mode", { detail: { mode: "form" } }));
    }
  }

  public async askDifferently(nodeId: string): Promise<boolean> {
    const designer = await this.ensureDesigner();
    const entry = this.builtEntry();
    if (!entry || !designer.askDifferently(entry.controller.snapshot(), nodeId, entry)) {
      return false;
    }
    const controller = entry.controller;
    let made: string | undefined;
    let from: string | undefined;
    let replaced = false;
    // Planned when the replacement runs — after a draft the prompt held it for is saved or
    // discarded — and put in the question's place alone, so taking it back is one Undo and
    // nothing else the pages hold (an entry the slots would refuse now) stands in its way.
    controller.requestReplaceComponent(
      nodeId,
      () => {
        const plan = designer.askDifferently(controller.snapshot(), nodeId, entry);
        made = plan?.id;
        const fills = (plan?.node.configuration as { fills?: unknown } | undefined)?.fills;
        from = typeof fills === "string" ? fills : undefined;
        return plan?.node;
      },
      {
        onResult: (result) => {
          replaced = result.ok && made !== undefined;
          if (replaced) {
            controller.select(made);
            // The page-only field is worded as the form field was, in every language.
            if (from !== undefined && made !== undefined) {
              const source = from;
              const target = made;
              rewriteFormTranslations(this.options.form, (map) => copyTranslations(map, "components", source, target));
            }
          }
        }
      }
    );
    return replaced;
  }

  private unlistenClicks(): void {
    this.clickRoot?.removeEventListener("click", this.onLinkClick);
    this.clickRoot = undefined;
  }

  /**
   * A click on a link while Try it runs the journey: the canvas keeps a link in the
   * form from opening, a new tab's included, and the Journey card says so.
   */
  private readonly onLinkClick = (event: Event): void => {
    const run = this.trying;
    if (run && (event.composedPath() as HTMLElement[]).some((element) => element?.tagName === "A" && element.hasAttribute?.("href"))) {
      run.journey?.linkHeld();
    }
  };

  /**
   * The Step view's box for the journey node `nodeId` (a placement is drawn under the form's id,
   * which selects it: `canvasSelectTargets`), else the step's sheet, which the Step view draws
   * no box of its own for.
   */
  private stepBox(entry: JourneyEntry, nodeId: string): HTMLElement | undefined {
    const canvas = this.canvas();
    const targets = entry.controller.canvasSelectTargets();
    const boxes = [...(canvas?.previewRoot?.()?.querySelectorAll<HTMLElement>(".db-node[data-component-id]") ?? [])];
    const box = boxes.find((element) => element.dataset.componentId === nodeId) ?? boxes.find((element) => targets?.get(element.dataset.componentId ?? "") === nodeId);
    return box ?? canvas?.shadowRoot?.querySelector<HTMLElement>(".canvas-page") ?? undefined;
  }

  /** The "Fills form field" box of whichever inspector shows it now (the docked one, or the strip's). */
  private fillsBox(): HTMLElement | undefined {
    const panels = [...(this.context?.root?.querySelectorAll?.("datum-builder-properties") ?? [])];
    for (const panel of panels) {
      const box = panel.shadowRoot?.querySelector<HTMLElement>('[data-prop="fills"]');
      if (box) {
        return box;
      }
    }
    return undefined;
  }

  /** The shell's canvas panel: the cards it draws, and Try it. */
  private canvas(): TryCanvas | undefined {
    return (this.context?.root?.querySelector?.("datum-builder-canvas") as TryCanvas | null | undefined) ?? undefined;
  }

  /**
   * Puts focus on `target` (focusable from script) once it has `fallen` — handed the deepest
   * focused element, `null` when focus is on the page itself — and follows it through the paints
   * that come for a moment after (`ticks` × 25 ms). Never taken from wherever the author has put
   * it meanwhile, nor by an earlier call's once another is made.
   */
  private followFocus(fallen: (active: Element | null) => boolean, target: () => HTMLElement | null | undefined, ticks = 40): void {
    if (typeof document === "undefined") {
      return;
    }
    const token = (this.focusToken = {});
    let tick = 0;
    const deepActive = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active === document.body ? null : active;
    };
    const step = (): void => {
      if (this.focusToken !== token) {
        return;
      }
      const found = fallen(deepActive()) ? target() : undefined;
      if (found) {
        if (!found.hasAttribute("tabindex")) {
          found.tabIndex = -1;
        }
        found.focus();
      }
      if ((tick += 1) < ticks) {
        setTimeout(step, 25);
      }
    };
    setTimeout(step, 0);
  }

  public async addUnassigned(): Promise<boolean> {
    const designer = await this.ensureDesigner();
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    if (!entry?.built) {
      return false;
    }
    const controller = entry.controller;
    let placed = false;
    controller.requestInsertComponents(
      // Planned when the insert runs: after a draft the prompt held it for is saved or discarded.
      () => {
        const journey = this.model.selected();
        const members = journey && journey.id === entry.id ? designer.unassigned(journey) : [];
        // A one-page journey's page takes them whatever is selected — nothing, right after it is
        // opened: a page added for them would split it behind the author's back.
        const place = journey !== undefined && this.hasOnePage(journey) ? "last" : "selected";
        return designer.addUnassignedEntries(controller.snapshot(), members, controller.selectedComponentId(), entry.pageIds, place, entry.references, entry.routeLinks);
      },
      {
        select: "none",
        onResult: (result) => {
          placed = result.ok && result.ids.length > 0;
        }
      }
    );
    return placed;
  }

  public async removeMissing(): Promise<boolean> {
    const designer = await this.ensureDesigner();
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    if (!entry?.built) {
      return false;
    }
    const controller = entry.controller;
    let removed = false;
    // Decided when the removal runs: after a draft the prompt held it for is saved or discarded.
    controller.requestRemoveComponents(() => designer.missingQuestions(controller.snapshot()), {
      onResult: (ids) => {
        removed = ids.length > 0;
      }
    });
    return removed;
  }

  /**
   * Every journey's texts as committed, whether or not its designer was ever opened: listing
   * needs no designer, so a host's catalog has them before the Journeys tab is.
   */
  public translatableTexts(words?: BuilderTextOptions): TranslatableText[] {
    const locale = this.locale();
    const sources = this.sources();
    // The builder's words for the rows' labels: the caller's, else the catalog the shell handed over.
    const text: BuilderTextOptions = words ?? { locale, catalog: this.textCatalog?.() };
    // A page's own nodes after the page's texts, each a group of its own keyed
    // `journey.<journeyId>.<ownId>`: the texts their type declares, as the form's would be
    // listed — read through the form's controller, whose registry knows the form's types. Their
    // translations live under the node's own id (`components › <id>`), as the renderer resolves them.
    return journeyTranslatableTexts(this.model.journeys, locale, sources, (journey, page, index) => {
      const out: JourneyTextRow[] = [];
      const stack: unknown[] = [...(page.components ?? [])].reverse();
      while (stack.length > 0) {
        const node = stack.pop();
        if (!isRecord(node) || node.type === PRESENTATION_REFERENCE_TYPE || typeof node.id !== "string" || typeof node.type !== "string") {
          continue;
        }
        const group = `journey.${journey.id}.${node.id}`;
        const label = isRecord(node.configuration) ? node.configuration.label : undefined;
        const said = typeof label === "string" ? resolveText(label, addressOf.component(node.id, "label"), locale, sources) : "";
        const groupLabel = builderText("journey.designer.grid.page", { name: journeyLabel(journey, locale, sources), number: index + 1, title: said.trim() !== "" ? said : node.id }, text);
        const own: ComponentNode = { id: node.id, type: node.type, configuration: isRecord(node.configuration) ? node.configuration : {} };
        // A worked-out value is no type of the form's: its one text is its label.
        out.push(
          ...(node.type === PRESENTATION_VALUE_TYPE
            ? journeyLabelText(own, group, groupLabel, text)
            : this.options.form.translatableTextsOf(own, { group, groupLabel }))
        );
        for (const held of isRecord(node.children) ? Object.values(node.children).reverse() : []) {
          if (Array.isArray(held)) {
            stack.push(...[...held].reverse());
          }
        }
      }
      return out;
    }, text, (componentId) => this.fieldLabelOf(componentId, locale, sources));
  }

  /** A form field's label in `locale` (its id when it has none or the form no longer has it): what a row of a Check answers step is worded as by default. */
  private fieldLabelOf(componentId: string, locale: string, sources: TextSources): string {
    const stack: ComponentNode[] = [this.options.form.snapshot()];
    while (stack.length > 0) {
      const node = stack.pop() as ComponentNode;
      if (node.id === componentId) {
        const label = isRecord(node.configuration) ? node.configuration.label : undefined;
        const said = typeof label === "string" ? resolveText(label, addressOf.component(node.id, "label"), locale, sources) : "";
        return said.trim() !== "" ? said : componentId;
      }
      stack.push(...Object.values(node.children ?? {}).flat());
    }
    return componentId;
  }

  // --- internals ---------------------------------------------------------------

  /**
   * The Rules tab of a page-only field: the conditions its type takes on the form —
   * shown, required (where the type offers Required), enabled, read-only — never a calculation,
   * a default or an option filter, which a presentation's own fields do not have (v1).
   */
  private ownRules(type: string): readonly RuleDescriptor[] {
    let found = this.ownRulesMemo.get(type);
    if (!found) {
      found = applicableRuleDescriptors(type, { offersRequired: this.options.form.typeOffersRequired(type), holdsData: false }).filter(
        (descriptor) => descriptor.kind === "condition" && descriptor.key !== "filter" && descriptor.key !== "navigationGating"
      );
      this.ownRulesMemo.set(type, found);
    }
    return found;
  }

  /**
   * What a rule's field box offers for the node being edited: a route's condition reads the
   * form's fields; a worked-out value the own fields of its page; a
   * page-only field's rule the form's fields and the journey's own (the designer's to list).
   */
  private ruleFieldOptions(nodeId: string): InspectorChoice[] {
    const entry = this.builtEntry();
    const own = entry ? this.designer?.ownRuleFields(entry.controller.previewSnapshot(), nodeId) : undefined;
    return own === undefined ? this.conditionFieldOptions() : own.alone ? own.choices : [...this.conditionFieldOptions(), ...own.choices];
  }

  /**
   * The same fields as {@link ruleFieldOptions}, for the formula editor: the form's with their
   * kinds and options (`formulaFieldsOf` over the committed form, labelled as the outline
   * labels them), a designer's own fields as fields of no particular kind.
   */
  private ruleFormulaFields(nodeId: string): FormulaField[] {
    const choices = this.ruleFieldOptions(nodeId);
    const labels = new Map<string, string>();
    const walk = (entry: NestedTreeNodeView): void => {
      labels.set(entry.id, entry.label);
      for (const slot of entry.slots) {
        for (const child of slot.children) {
          walk(child);
        }
      }
    };
    walk(this.options.form.treeView());
    const known = new Map(
      formulaFieldsOf(this.formRoot(), { labelOf: (componentId) => labels.get(componentId), locale: this.locale() }).map((field) => [field.path, field])
    );
    return choices.map((choice) => known.get(choice.value) ?? { path: choice.value, label: choice.label, kind: "other", options: [] });
  }

  /**
   * The form components a route's condition can read as answered: those asked on the page at `at`
   * in the entry's tree and the pages before it (a route is tried once its page is on the path),
   * each with all it holds. A question listed as a layout stands for everything inside it, as the
   * path engine's ownership does.
   */
  private askedThroughPage(entry: JourneyEntry, at: number): readonly string[] {
    const pages = entry.controller.previewSnapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
    const listed = new Set<string>();
    const collect = (node: ComponentNode): void => {
      const configuration = isRecord(node.configuration) ? node.configuration : {};
      for (const key of ["componentId", "fills"]) {
        const value = configuration[key];
        if (typeof value === "string" && value !== "") {
          listed.add(value);
        }
      }
      for (const group of Object.values(node.children ?? {})) {
        group.forEach(collect);
      }
    };
    for (const page of pages.slice(0, at + 1)) {
      (page.children?.[JOURNEY_CONTENT_SLOT] ?? []).forEach(collect);
    }
    // Each listed component with all it holds.
    const found = new Set<string>();
    const walk = (node: ComponentNode, inside: boolean): void => {
      const within = inside || listed.has(node.id);
      if (within) {
        found.add(node.id);
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          walk(child, within);
        }
      }
    };
    walk(this.formRoot(), false);
    return [...found];
  }

  private locale(): string {
    return this.options.form.currentLocale();
  }

  private formRoot(): ComponentNode {
    this.formRootMemo ??= this.options.form.snapshot();
    return this.formRootMemo;
  }

  /** Every component id of the form as committed, the root's included: what a designer's own node ids are numbered around. */
  private formIds(): string[] {
    const ids: string[] = [];
    const stack: ComponentNode[] = [this.formRoot()];
    while (stack.length > 0) {
      const node = stack.pop() as ComponentNode;
      ids.push(node.id);
      for (const group of Object.values(node.children ?? {})) {
        stack.push(...group);
      }
    }
    return ids;
  }

  /**
   * The ids the presentations' own nodes carry, claimed for the form's controller:
   * every journey's as the catalog holds them, and every built designer's as its
   * tree stands — so an own node just added, renamed or removed is claimed or let go at once,
   * even while its tree cannot be written.
   */
  private claimedOwnIds(): Set<string> {
    const ids = journeyOwnNodeIds(this.model.configuration);
    for (const entry of this.entries.values()) {
      if (entry.built) {
        for (const id of journeyTreeOwnIds(entry.controller.snapshot())) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  /** What resolves a text in the builder's locale: the definition's translations under the host's catalog. */
  private sources(): TextSources {
    return { translations: formTranslationsOf(this.options.form), catalog: this.options.translations?.() };
  }

  /**
   * Keeps the definition's translations with the journeys, as one step of the form's
   * history: a journey, page or page-only node that is gone has its entries pruned from every
   * language (and held in {@link pruned} against an Undo), one that is back has them restored,
   * and one given another id has them moved (`renames`). Called after the catalog holds the
   * journey as `after` (`before` is how it stood; `undefined` for none). A page-only node is
   * worded under its own id, shared by every journey that holds it, so its entries are pruned
   * only when no journey holds it any more — and never when the form has a component of that id.
   *
   * With `block` (the journeys' block as it stood before the change, which the caller has
   * already applied) the rewrite is one step of the form's history that also holds the block
   * ({@link blockCommand}): one Undo brings the journey, page or copy and its entries back
   * together. A page's own Undo in the designer still restores the page, and writes the entries
   * again from {@link pruned} only where the map lacks them, so the two never double-restore.
   * `block.also` rewrites the map further in the same step. A catalog action calls this inside
   * its `formSteps.stepped` run, whose step holds the block whether or not a translation moved,
   * so Undo brings a removed journey back on a form without translations as on one with them.
   */
  private followTranslations(
    before: Journey | undefined,
    after: Journey | undefined,
    renames: { pages?: ReadonlyArray<{ from: string; to: string }>; own?: ReadonlyArray<{ from: string; to: string }> } = {},
    block?: { before: JourneyConfiguration | undefined; also?: ((map: FormTranslations) => FormTranslations) | undefined }
  ): void {
    const form = this.options.form;
    const current = formTranslationsOf(form);
    const id = after?.id ?? before?.id;
    if ((current || this.pruned.size > 0) && id !== undefined) {
      let next: FormTranslations = current ?? {};
      const prune: TranslationPrefix[] = [];
      const restore: TranslationPrefix[] = [];
      const whole = (owner: string): TranslationPrefix => ({ kind: "journeys", owner });
      const page = (owner: string, pageId: string): TranslationPrefix => ({ kind: "journeys", owner, path: ["pages", pageId] });
      const node = (nodeId: string): TranslationPrefix => ({ kind: "components", owner: nodeId });
      // The ids this re-keys, for the change event a host keeping a catalog under the same addresses reads.
      const announced: RenamedTextId[] = [];
      if (before && after && before.id !== after.id) {
        next = moveTranslations(next, whole(before.id), whole(after.id));
        announced.push({ kind: "journeys", from: before.id, to: after.id });
      }
      if (!before && after) {
        restore.push(whole(after.id));
      } else if (before && !after) {
        prune.push(whole(before.id));
      } else if (before && after) {
        const was = new Set((before.pages ?? []).map((entry) => entry.id));
        const now = new Set((after.pages ?? []).map((entry) => entry.id));
        const movedFrom = new Set((renames.pages ?? []).map((entry) => entry.from));
        const movedTo = new Set((renames.pages ?? []).map((entry) => entry.to));
        for (const rename of renames.pages ?? []) {
          next = moveTranslations(next, page(id, rename.from), page(id, rename.to));
          announced.push({ kind: "journeys", owner: id, within: "pages", from: rename.from, to: rename.to });
        }
        for (const pageId of was) {
          if (!now.has(pageId) && !movedFrom.has(pageId)) {
            prune.push(page(id, pageId));
          }
        }
        for (const pageId of now) {
          if (!was.has(pageId) && !movedTo.has(pageId)) {
            restore.push(page(id, pageId));
          }
        }
      }
      const ownBefore = ownNodeIdsOf(before);
      const ownAfter = ownNodeIdsOf(after);
      if (ownBefore.size > 0 || ownAfter.size > 0) {
        const formIds = formIdsOf(this.formRoot());
        const elsewhere = new Set<string>();
        for (const other of this.model.journeys) {
          if (other.id !== id) {
            ownNodeIdsOf(other).forEach((nodeId) => elsewhere.add(nodeId));
          }
        }
        const moves = (renames.own ?? []).filter((entry) => ownBefore.has(entry.from) && ownAfter.has(entry.to) && !formIds.has(entry.from) && !formIds.has(entry.to));
        const movedFrom = new Set(moves.map((entry) => entry.from));
        const movedTo = new Set(moves.map((entry) => entry.to));
        for (const move of moves) {
          next = moveTranslations(next, node(move.from), node(move.to));
          announced.push({ kind: "components", from: move.from, to: move.to });
        }
        for (const nodeId of ownBefore) {
          if (!ownAfter.has(nodeId) && !movedFrom.has(nodeId) && !elsewhere.has(nodeId) && !formIds.has(nodeId)) {
            prune.push(node(nodeId));
          }
        }
        for (const nodeId of ownAfter) {
          if (!ownBefore.has(nodeId) && !movedTo.has(nodeId) && !formIds.has(nodeId)) {
            restore.push(node(nodeId));
          }
        }
      }
      for (const prefix of prune) {
        const held = listTranslations(next).filter((item) => underPrefix(item.address, prefix));
        if (held.length > 0) {
          this.pruned.set(addressKey(prefix), held);
          // An Undo that never comes must not grow the session without end: the oldest are let go.
          if (this.pruned.size > PRUNED_KEPT) {
            this.pruned.delete(this.pruned.keys().next().value as string);
          }
        }
        next = pruneTranslations(next, prefix);
      }
      const back = restore.flatMap((prefix) => {
        const key = addressKey(prefix);
        const held = this.pruned.get(key) ?? [];
        this.pruned.delete(key);
        return held;
      });
      if (back.length > 0) {
        // Fingerprinted against the default the text has now: an entry that was source-changed when it went comes back current.
        const defaults = new Map(this.translatableTexts().flatMap((row) => (row.address ? [[addressKey(row.address), row.default] as const] : [])));
        for (const item of back) {
          const text = defaults.get(addressKey(item.address));
          if (text !== undefined && text !== "" && readTranslation(next, item.locale, item.address) === undefined) {
            next = writeTranslation(next, item.locale, item.address, item.entry.text, text);
          }
        }
      }
      if (block?.also) {
        next = block.also(next);
      }
      if (next !== current) {
        rewriteFormTranslations(form, () => next, block ? this.blockCommand(block.before, this.model.configuration) : undefined, announced);
      }
    }
  }

  /**
   * A journey made from the form is titled from texts of the form (a section's label, the
   * form's title): the title is a plain string, so what the form says of it in other languages
   * is copied to the page's own address, as a rewrite of the map made in the step
   * that adds the journey. An entry that was source-changed is not carried: the copy would claim
   * a currency it does not have.
   */
  private titleCarry(journey: Journey, origins: ReadonlyArray<{ pageId: string; from: TextAddress }>): ((map: FormTranslations) => FormTranslations) | undefined {
    if (origins.length === 0) {
      return undefined;
    }
    return (map) => {
      let next = map;
      for (const origin of origins) {
        const title = journey.pages.find((entry) => entry.id === origin.pageId)?.title;
        if (typeof title !== "string" || title === "") {
          continue;
        }
        for (const item of listTranslations(map).filter((held) => addressKey(held.address) === addressKey(origin.from))) {
          if (!isStale(item.entry, title)) {
            next = writeTranslation(next, item.locale, addressOf.journeyPage(journey.id, origin.pageId, "title"), item.entry.text, title);
          }
        }
      }
      return next;
    };
  }

  /** The form's title as written (its default-language string), for a one-page journey's page title; none when the form has none. */
  private formTitle(): string | undefined {
    const configuration = this.formRoot().configuration;
    const title = isRecord(configuration) ? configuration.title : undefined;
    return typeof title === "string" && title.trim() !== "" ? title : undefined;
  }

  /** Runs a catalog action the shell asked for; a refusal is reported, not thrown into the shell. */
  private guard(message: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.onError?.(message, error);
    }
  }

  private defaultNewName(): string {
    const base = "Journey";
    const labels = new Set(this.model.journeys.map((journey) => journeyLabel(journey, this.locale(), this.sources())));
    if (!labels.has(base)) {
      return base;
    }
    let n = 2;
    while (labels.has(`${base} ${n}`)) {
      n += 1;
    }
    return `${base} ${n}`;
  }

  /**
   * Whether `journey` is one questions page with no routes (`journeyHasOnePage`): over its
   * designer's tree once that is built — as the canvas shows it — so a route just added to its
   * page counts before its target is chosen and it is written; else by the journey as written.
   * What the Map button and "Add unassigned" read.
   */
  private hasOnePage(journey: Journey): boolean {
    const entry = this.entries.get(journey.id);
    if (entry?.built && entry.design) {
      const view = entry.design.view();
      return journeyHasOnePage(view.check.journey, view.tree);
    }
    return journeyHasOnePage(journey);
  }

  private documentList(): BuilderDocument[] {
    const locale = this.locale();
    const catalog = this.sources();
    // "Default" marks the journey the form really opens as: none while it opens whole.
    const defaultId = this.opensAs === "form" ? undefined : this.model.defaultId;
    return this.model.journeys.map((journey) => ({
      id: journey.id,
      label: journeyLabel(journey, locale, catalog),
      isDefault: journey.id === defaultId
    }));
  }

  /**
   * The Form panel's "Opens as" row, while the form has a journey: the
   * whole form, or one of the journeys by name. Choosing one makes it
   * the default at once, through the catalog as the documents menu does; only `opensAs` waits
   * for the panel's Save.
   */
  private settingsRows(): BuilderFormSettingRow[] {
    const journeys = this.model.journeys;
    if (journeys.length === 0) {
      return [];
    }
    const locale = this.locale();
    const catalog = this.sources();
    // Read live: `choose` moves the default before the panel drafts the value, and the panel
    // compares the draft with what the row reads then — a row remembering the default it was
    // built with would count a settled choice as a pending change.
    const fallback = (): Journey => {
      const current = this.model.journeys;
      return current.find((journey) => journey.id === this.model.defaultId) ?? current[0] ?? journeys[0]!;
    };
    const named = (journey: Journey): string => journeyLabel(journey, locale, catalog);
    const whole = wholeFormValue(journeys);
    const choices: InspectorChoice[] = [{ value: whole, label: "The whole form" }, ...journeys.map((journey) => ({ value: journey.id, label: named(journey) }))];
    const makeDefault = (value: string): void => {
      if (value !== whole && value !== this.model.defaultId && journeys.some((journey) => journey.id === value)) {
        this.setDefaultJourney(value);
      }
    };
    return [
      {
        id: "journeys.opensAs",
        label: "Opens as",
        description:
          "What the form opens as where the host names nothing; choosing a journey makes it the default. Whichever it is, any journey saved here is accepted by the server as a way to submit.",
        choices,
        note: `Default: ${named(fallback())}.`,
        open: { label: "Open the journeys", document: fallback().id },
        get: () => (this.opensAs === "form" ? whole : fallback().id),
        choose: makeDefault,
        // The default and what the form opens as, from one Save: one step.
        set: (value) =>
          this.formSteps.stepped(() => {
            makeDefault(value);
            this.setOpensAs(value === whole ? "form" : "journey");
          })
      }
    ];
  }

  /** The form components a condition may read (Rules tab): answer-holding, outside every repeating section. */
  private conditionFieldOptions(): InspectorChoice[] {
    if (!this.readableMemo) {
      const readable = new Set<string>();
      const visit = (node: ComponentNode, inEntries: boolean): void => {
        const entries = inEntries || collectionPathOf(node) !== undefined;
        if (!entries && holdsData(node, this.options.isValueless ? { isValueless: this.options.isValueless } : {})) {
          readable.add(node.id);
        }
        for (const group of Object.values(node.children ?? {})) {
          for (const child of group) {
            visit(child, entries);
          }
        }
      };
      for (const group of Object.values(this.formRoot().children ?? {})) {
        for (const child of group) {
          visit(child, false);
        }
      }
      this.readableMemo = readable;
    }
    const readable = this.readableMemo;
    return ruleFieldOptions(this.options.form.treeView(), undefined).filter((choice) => readable.has(choice.value));
  }

  private signatureOfDocuments(): string {
    return JSON.stringify([this.documentList(), this.model.selected()?.id ?? null]);
  }

  private signatureOfSettings(): string {
    return JSON.stringify(this.settingsRows().map(({ get, set: _set, ...row }) => ({ ...row, value: get() })));
  }

  /** Tells the shell what moved: the documents, the Form panel's rows, the bar's count. */
  private syncControls(): void {
    this.notifyLogic();
    this.syncViews();
    this.syncPanels();
    const documents = this.signatureOfDocuments();
    if (documents !== this.documentsSignature) {
      this.documentsSignature = documents;
      for (const listener of [...this.listeners]) {
        listener();
      }
    }
    const settings = this.signatureOfSettings();
    if (settings !== this.settingsSignature) {
      this.settingsSignature = settings;
      for (const listener of [...this.settingsListeners]) {
        listener();
      }
    }
  }

  /** Commits an edited block: the page follows `select`, the chrome is redrawn, the change reported. */
  private applyConfiguration(
    next: JourneyConfiguration | undefined,
    journey: Journey | undefined,
    reason: JourneyBuilderModeChangeDetail["reason"],
    select?: string
  ): void {
    // The page stays on the journey it shows: another default, say, does not move it.
    if (select === undefined && this.model.journeyId === undefined) {
      this.model.journeyId = this.model.selected()?.id;
    }
    const listedBefore = new Map(this.model.journeys.map((listedJourney) => [listedJourney.id, listedJourney]));
    const result = this.model.apply(next, select);
    this.edited = true;
    // A journey no longer listed (removed, or re-identified by a host) takes its designer with it.
    const listed = new Set(this.model.journeys.map((entry) => entry.id));
    for (const [id, entry] of this.entries) {
      if (!listed.has(id)) {
        entry.step?.dispose();
        entry.unsubscribe();
        this.entries.delete(id);
      }
    }
    const entry = result.after ? this.entries.get(result.after.id) : undefined;
    // The name lives on the open tree's root too (the Journey panel's "Journey name"); a catalog
    // rename is not the tree's to undo.
    const pushName = (into: JourneyEntry, name: string | undefined): void => {
      this.syncing = true;
      try {
        into.controller.setPropertyUnrecorded(into.controller.rootId(), "name", name ?? "");
        this.refreshReported(into);
      } finally {
        this.syncing = false;
      }
    };
    if (result.renamed && result.after && entry?.built) {
      pushName(entry, result.after.name);
    } else if (result.rebuild && entry && select === undefined) {
      // The journey on the page changed underneath its designer (a host replaced it): start over.
      entry.built = false;
    }
    // A host may replace or rename a journey that is not on the page: a designer already built
    // over it follows by the same rule — the name alone into its tree, anything else a build
    // afresh when it is next put on the page — or its next edit would write the tree it still
    // holds over the change. Catalog actions that leave a journey as it was keep its history.
    for (const [id, other] of this.entries) {
      if (other === entry || !other.built) {
        continue;
      }
      const was = listedBefore.get(id);
      const now = this.model.journeys.find((listedJourney) => listedJourney.id === id);
      const change = was && now ? journeyChange(was, now) : "none";
      if (change === "name" && now) {
        pushName(other, now.name);
      } else if (change === "structure") {
        other.built = false;
      }
    }
    if (this.active) {
      // Built before the shell hears of it, so the panels it re-points find the journey up.
      this.ensureFresh();
    }
    this.syncControls();
    // The journey on the page draws what the form opens as on its face, and the names
    // of the journeys the select lists: drawn again over the same tree, as a form edit does.
    if (this.active) {
      this.builtEntry()?.controller.repaintPreview();
    }
    this.options.onChange?.({
      ...(journey ? { journey } : {}),
      configuration: this.journeyConfiguration,
      reason,
      ...(select !== undefined ? { select } : {})
    });
    if (select !== undefined && result.after && result.after.id === select && result.before?.id !== select) {
      this.options.onSelect?.({ journeyId: select, journey: result.after });
    }
    this.applyView();
  }

  // --- the entries -------------------------------------------------------------

  private entryFor(id: string): JourneyEntry {
    const existing = this.entries.get(id);
    if (existing) {
      return existing;
    }
    const controller = new BuilderController({ componentTypes: [], initialRoot: idleRoot() });
    const entry: JourneyEntry = {
      id,
      controller,
      pageIds: new Map(),
      routeLinks: new Map(),
      references: new Map(),
      built: false,
      building: false,
      following: false,
      unsubscribe: () => undefined
    };
    const offChange = controller.on("change", (event) => this.onEntryChange(entry, event));
    // Registered before the shell's panels hear of the selection: a map that throws must not
    // keep the outline and the inspector from hearing it (the controller's emit has no guard).
    const offSelection = controller.on("selection", () => this.onEntrySelection(entry));
    entry.unsubscribe = () => {
      offChange();
      offSelection();
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** The journey's selection moved (the outline, the inspector, the Pages view, an undo): the map marks it. */
  private onEntrySelection(entry: JourneyEntry): void {
    const map = this.map;
    if (!map || !entry.mapSubject) {
      return;
    }
    try {
      map.select(entry.mapSubject);
    } catch (error) {
      this.options.onError?.("The journey map could not follow the selection", error);
    }
  }

  /** The journey as the tree stands, as the baseline the next change is measured against. */
  private refreshReported(entry: JourneyEntry): void {
    const designer = this.designer;
    if (designer) {
      const tree = entry.controller.snapshot();
      const journey = designer.journeyFromTree(tree, entry.id, { pageIds: entry.pageIds, routeLinks: entry.routeLinks, references: entry.references });
      entry.reportedJson = JSON.stringify(journey ?? null);
      entry.reportedPages = journey ? writtenPages(tree, journey) : undefined;
    }
  }

  /** An edit on one journey's tree: the catalog follows, the host hears. */
  private onEntryChange(entry: JourneyEntry, event: BuilderChangeEvent): void {
    const before = entry.lastRoot;
    entry.lastRoot = event.root;
    // A deletion in the Step view (a keyboard Delete, Take it off, the inspector's confirmed
    // Delete) leaves focus on the box drawn in its place, else the one before it, else the step's
    // sheet: focus fell with the box, to the canvas's form element or the page. The map
    // moves focus itself after its own delete.
    if (event.reason === "remove" && before && this.active && entry.built && entry === this.builtEntry() && this.stepNow()) {
      const nodeId = journeyNodeAfterRemoval(before, event.root);
      if (nodeId !== undefined) {
        const sheet = (): Element | null | undefined => this.canvas()?.shadowRoot?.querySelector("[data-preview]");
        this.followFocus((active) => active === null || active === sheet() || active === this.canvas(), () => this.stepBox(entry, nodeId));
      }
    }
    if (event.reason !== "select") {
      // The faces read the tree afresh on the repaint this change brings, and a journey Try it
      // runs works the path out again — for a draft keystroke too, which is what makes it live.
      // Its update redraws the Try panel (`tryRefresh`).
      entry.design?.invalidate();
      if (entry.previewSubject) {
        this.trying?.follow();
        this.trying?.journey?.refresh(entry.previewSubject);
      }
      // The map draws again once the change is done (a keystroke's once), or when next shown.
      if (entry.mapSubject) {
        this.map?.refresh(entry.mapSubject, event.live === true);
        this.trying?.refreshMap(entry.mapSubject, event.live === true);
      }
    }
    // `init` is the designer's own seeding; `preview` and `select` leave the journey as it was;
    // the follow-up of an own node's rename is written below, with the rename.
    if (event.reason === "init" || event.reason === "preview" || event.reason === "select" || !entry.built || entry.building || entry.following) {
      return;
    }
    const designer = this.designer;
    const listed = this.model.journeys.find((journey) => journey.id === entry.id);
    if (!designer || !listed) {
      return;
    }
    // A node of the journey's own renamed: its own rules and worked-out values follow,
    // in one more step, and the journey is written once, with both.
    const root = event.renamed && !this.syncing ? (this.followOwnRename(entry, listed, event.renamed.from, event.renamed.to) ?? event.root) : event.root;
    let problems: string[] = [];
    const next = designer.journeyFromTree(root, entry.id, {
      pageIds: entry.pageIds,
      routeLinks: entry.routeLinks,
      references: entry.references,
      onError: (found) => {
        problems = found;
      }
    });
    if (!next) {
      // Kept as the last journey that could be written; said once per distinct reason.
      const problem = problems.join("; ");
      if (problem !== entry.lastProblem) {
        entry.lastProblem = problem;
        this.options.onError?.(`The journey "${entry.id}" cannot be saved as it stands: ${problem}`);
      }
      return;
    }
    entry.lastProblem = undefined;
    const nextJson = JSON.stringify(next);
    if (nextJson === entry.reportedJson) {
      // An edit that left the journey as it was: nothing to keep or report. The chrome still
      // follows the tree — a route added to a one-page journey's page is not written until its
      // target is chosen, yet the Map comes at once, as the card draws it.
      // A page node renamed under an id of its own is still that page: known by its new node from now on.
      entry.reportedPages = writtenPages(root, next);
      this.syncControls();
      return;
    }
    // A tree can hold a state the block cannot (a page id repeated for a moment): the catalog's
    // own shape check refuses it here, said once per reason like any unwritable tree, and the
    // last journey that could be written stays.
    const unusable = journeyUnusableProblems(next);
    if (unusable.length > 0) {
      const problem = unusable.join("; ");
      if (problem !== entry.lastProblem) {
        entry.lastProblem = problem;
        this.options.onError?.(`The journey "${entry.id}" cannot be saved as it stands: ${problem}`);
      }
      return;
    }
    const blockBefore = this.model.configuration;
    try {
      this.model.replaceQuietly(entry.id, next);
    } catch (error) {
      this.options.onError?.("A journey edit could not be kept", error);
      return;
    }
    // A page whose id this edit changed (its id saved, its node renamed): told after the edit, for the Tests to follow.
    const pagesNow = writtenPages(root, next);
    const renamedPages = pageRenames(entry.reportedPages, pagesNow, event.renamed);
    // The journey's translations follow the edit: a page deleted has its entries pruned, one
    // whose id changed has them moved, a page-only node likewise. The form's history
    // takes it as its own step. Not while the Step view's Undo steps an entry that holds a form
    // step as well: that step is this follow-up, and is stepped right after (step-history.ts).
    // The follow-up is the tree step's own (`formSteps.followUp`): the tree's own Undo or Redo of
    // an edit whose follow-up is the form's next entry that way steps that entry, which puts the
    // entries and the block back as they were (the block already reads as the tree, so its part
    // writes nothing), and writes no entry over a catalog step held under it.
    if (!entry.step?.stepping(this.options.form)) {
      this.formSteps.followUp(entry.controller, event.historyStep, () =>
        this.followTranslations(listed, next, { pages: renamedPages, ...(event.renamed ? { own: [{ from: event.renamed.from, to: event.renamed.to }] } : {}) }, { before: blockBefore })
      );
    }
    entry.reportedJson = nextJson;
    entry.reportedPages = pagesNow;
    this.edited = true;
    this.syncControls();
    if (!this.syncing) {
      this.options.onChange?.({ journey: next, configuration: this.journeyConfiguration, reason: event.reason });
      for (const renamed of renamedPages) {
        this.options.onChange?.({ journey: next, configuration: this.journeyConfiguration, reason: "page-rename", renamed: { journeyId: entry.id, ...renamed } });
        this.announceRename("page", entry.id, renamed.from, renamed.to);
      }
    }
  }

  /**
   * Brings the journey on the page up: built over its catalog entry when it is not yet, else
   * given the form's locale and locales when they moved — so history and
   * selection survive a round trip through another tab. Needs the designer.
   */
  private ensureFresh(): void {
    const designer = this.designer;
    const selected = this.model.selected();
    if (!designer || !selected) {
      return;
    }
    const entry = this.entryFor(selected.id);
    if (!entry.built) {
      this.build(entry, selected, designer);
      return;
    }
    this.syncLocale(entry);
    this.syncPalette(entry, designer);
  }

  /** The palette follows the builder's words when they moved since the journey was built or last relabelled: not an edit. */
  private syncPalette(entry: JourneyEntry, designer: JourneyDesigner): void {
    const words = { locale: this.locale(), catalog: this.textCatalog?.() };
    const seen = entry.paletteWords;
    entry.paletteWords = words;
    if (seen && (seen.locale !== words.locale || seen.catalog !== words.catalog)) {
      const relabelled = designer.relabel(entry.controller.componentTypes());
      // The Step view hides the designer's own Page, Form field and Route entries; wording them again keeps that.
      entry.controller.setOptions({ componentTypes: entry.step?.syncTypes(relabelled) ?? relabelled }, { silent: true });
      entry.controller.repaintPreview();
    }
  }

  private build(entry: JourneyEntry, journey: Journey, designer: JourneyDesigner): void {
    // A designer built again starts the Step view over (the next `applyView` brings it up again), so what it left on the controller goes first.
    if (entry.step) {
      entry.step.dispose();
      entry.step = undefined;
      entry.controller.setOptions(
        {
          assets: undefined,
          canvasView: undefined,
          canvasJourneyView: undefined,
          canvasTags: undefined,
          canvasRegionOwner: undefined,
          canvasSelectTarget: undefined,
          canvasStepper: undefined,
          canvasScheme: undefined
        },
        { silent: true }
      );
    }
    entry.pageIds.clear();
    entry.routeLinks.clear();
    entry.references.clear();
    // Its own node ids are numbered around the form's too.
    const root = designer.treeFromJourney(journey, { pageIds: entry.pageIds, references: entry.references, formIds: this.formIds() });
    entry.design = designer.entry({
      journeyId: () => entry.id,
      tree: () => entry.controller.previewSnapshot(),
      // The own types the journey holds get their faces from the tree it is built with: the
      // controller still holds the idle one until `setOptions` below.
      root,
      pageIds: entry.pageIds,
      routeLinks: entry.routeLinks,
      references: entry.references,
      unlisted: () => this.model.unlisted
    });
    entry.previewSubject = {
      journeyId: entry.id,
      tree: () => entry.controller.previewSnapshot(),
      pageIds: entry.pageIds,
      routeLinks: entry.routeLinks
    };
    const design = entry.design;
    entry.mapSubject = {
      journeyId: entry.id,
      name: () => {
        const listed = this.model.journeys.find((journey) => journey.id === entry.id);
        return listed ? journeyLabel(listed, this.locale(), this.sources()) : entry.id;
      },
      view: () => design.view(),
      selected: () => entry.controller.selectedComponentId()
    };
    entry.building = true;
    try {
      entry.controller.setOptions({
        ...entry.design.builderOptions,
        initialRoot: root,
        locale: this.locale(),
        localization: this.options.form.localization()
      });
    } finally {
      entry.building = false;
    }
    // The baseline is the normalizer's own output, so an unedited journey is never reported; the
    // catalog keeps the journey as given until an edit replaces it.
    const built = designer.journeyFromTree(root, entry.id, { pageIds: entry.pageIds, routeLinks: entry.routeLinks, references: entry.references });
    entry.reportedJson = JSON.stringify(built ?? null);
    entry.reportedPages = built ? writtenPages(root, built) : undefined;
    entry.lastProblem = undefined;
    entry.paletteWords = { locale: this.locale(), catalog: this.textCatalog?.() };
    entry.built = true;
  }

  /** The form's locale and locales onto a journey's controller, when they moved since it was built: not an edit. */
  private syncLocale(entry: JourneyEntry): void {
    let moved = false;
    const locale = this.locale();
    if (entry.controller.currentLocale() !== locale) {
      entry.controller.setOptions({ locale }, { silent: true });
      moved = true;
    }
    const before = JSON.stringify(entry.controller.localization() ?? null);
    entry.controller.setLocalization(this.options.form.localization(), { silent: true });
    if (moved || JSON.stringify(entry.controller.localization() ?? null) !== before) {
      entry.controller.repaintPreview();
    }
  }

  /**
   * The form changed: its index is read afresh by the faces and pickers, the journey on the
   * page repaints (never rebuilt), and a rename is followed.
   */
  private onFormChange(event: BuilderChangeEvent): void {
    if (event.reason === "select") {
      return;
    }
    // A draft typed into the Form's inspector moves nothing the journeys read (the form as
    // committed: its index, the faces, the map, the Try session): only the Step view, which draws
    // the draft, draws again. A commit (a mutation heard since the last change worked on), a
    // rename, an undo or the last draft going is worked on whole, below.
    const mutated = this.formMutations !== this.formMutationsSeen;
    this.formMutationsSeen = this.formMutations;
    if (event.reason === "edit" && !mutated && !event.renamed && !event.renameStepped && event.historyStep === undefined && this.options.form.hasPendingChanges()) {
      if (this.active && this.stepNow()) {
        this.builtEntry()?.controller.repaintPreview();
      }
      return;
    }
    this.formRootMemo = undefined;
    this.readableMemo = undefined;
    this.designer?.invalidateForm();
    if (event.renamed) {
      this.followRename(event.renamed.from, event.renamed.to);
    }
    // An Undo or a Redo of a rename moves the id back or again: the journeys, a document beside
    // the form's history, follow it the same way, so none names an id the form no longer has.
    if (event.renameStepped) {
      this.followRename(event.renameStepped.from, event.renameStepped.to);
    }
    // A new tree or new locales rebuild the runtime Try it runs (answers replayed), another
    // locale switches it; its update redraws the Try panel. The canvas draws the form's look.
    this.trying?.journey?.formChanged();
    // The map reads the form too (the names, the conditions in words, what may be hidden): drawn
    // again once this change is done, or, off the page (another tab), when next shown.
    this.map?.refresh();
    this.trying?.refreshMap();
    if (this.active) {
      const selected = this.model.selected();
      const entry = selected ? this.entries.get(selected.id) : undefined;
      if (entry?.built) {
        entry.controller.repaintPreview();
      }
      this.syncControls();
      this.applyView();
    }
  }

  /**
   * A form component renamed: every journey's pages and conditions follow
   * (`renameReferencesInConfiguration`), and each built designer is rewritten in place, so its
   * history survives, never half renamed. The rename is a step of the form's history, and the
   * follow-up is no entry of a journey's: the rename's Undo and Redo move the id back and again
   * (`BuilderChangeEvent.renameStepped`), and the journeys follow each the same way.
   */
  private followRename(from: string, to: string): void {
    const before = this.model.configuration;
    // The block first; then every built designer's tree, whether or not the block named the
    // old id: a tree holds what is not written yet too — a route with no target chosen, an
    // unfinished worked-out value, a tree that cannot be written — and it is written as it
    // stands once finished, so it must follow as well.
    this.model.renameComponent(from, to);
    let treesFollowed = false;
    this.syncing = true;
    try {
      for (const entry of this.entries.values()) {
        if (!entry.built) {
          continue;
        }
        const edits = journeyRenameEdits(entry.controller.snapshot(), "form", from, to);
        if (edits.length === 0) {
          continue;
        }
        treesFollowed = true;
        // No entry of the journey's history: the form's rename is the step, and its Undo and Redo
        // write the follow-up again (`renameStepped`), so the tree's Undo never takes it back alone.
        entry.controller.setProperties(edits, { unrecorded: true });
        this.refreshReported(entry);
      }
    } finally {
      this.syncing = false;
    }
    if (this.model.configuration === before) {
      // Only what is not written yet followed: the block, and what a host sees, are as they were.
      if (treesFollowed) {
        this.syncControls();
      }
      return;
    }
    this.edited = true;
    this.syncControls();
    this.options.onChange?.({ configuration: this.journeyConfiguration, reason: "form-rename" });
  }

  /**
   * A node of the journey's own renamed in its tree (`renameId`, or a Save of a drafted
   * id): the journey's own rules and worked-out values read it by its id, so they follow, as one
   * `setProperties` written as the rename is heard, so it joins the rename's own entry of the
   * journey's history (`BuilderController.renameId`: a rename and its rewrites are one step). The
   * tree after the follow-up; `undefined` when nothing reads the node, or `to` is not a node of
   * the journey's own — or the node was one the shared rules drop (`journeyOwnership` of the
   * journey as last written: its id a form component's, a duplicate, an entry ignored), which
   * nothing ever read, so what reads its old id goes on reading what it read.
   */
  private followOwnRename(entry: JourneyEntry, listed: Journey, from: string, to: string): ComponentNode | undefined {
    const tree = entry.controller.snapshot();
    if (!journeyTreeOwnIds(tree).includes(to) || journeyOwnership(this.formRoot(), listed).ownNodes?.[from] !== true) {
      return undefined;
    }
    const edits = journeyRenameEdits(tree, "own", from, to);
    if (edits.length === 0) {
      return undefined;
    }
    entry.following = true;
    try {
      entry.controller.setProperties(edits);
    } finally {
      entry.following = false;
    }
    return entry.controller.snapshot();
  }

  // --- the chrome ----------------------------------------------------------------

  // --- Try it ---------------------------------------------

  /**
   * What makes the journey Try it runs, once its chunk is in: the designer loads it (retried
   * after a failure), one load at a time. Rejects without a designer.
   */
  private prepareTry(): Promise<JourneyTrySessionMaker> {
    if (this.tryMaker) {
      return Promise.resolve(this.tryMaker);
    }
    if (this.tryLoad) {
      return this.tryLoad;
    }
    const designer = this.designer;
    if (!designer) {
      return Promise.reject(new Error("The Journeys designer is not loaded"));
    }
    const load = designer.prepareTry();
    this.tryLoad = load;
    load.then(
      (maker) => {
        if (this.tryLoad === load) {
          this.tryLoad = undefined;
          this.tryMaker = maker;
        }
      },
      () => {
        if (this.tryLoad === load) {
          this.tryLoad = undefined;
        }
      }
    );
    return load;
  }

  /**
   * The chunk loaded ahead while a journey is on the page, once the page is idle, so Try it
   * (whose session the canvas makes at once) starts on the journey. Quiet: a failure here is
   * said by the Try it that meets it, which loads it again. Once per journey put on the page, so
   * a failed load is not tried again on every repaint.
   */
  private warmTry(journeyId: string): void {
    if (this.tryMaker || this.tryLoad || this.tryWarmed === journeyId || !this.designer) {
      return;
    }
    this.tryWarmed = journeyId;
    const run = (): void => {
      if (!this.disposed) {
        this.prepareTry().catch(() => undefined);
      }
    };
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void) => unknown }).requestIdleCallback;
    if (typeof idle === "function") {
      idle(run);
    } else {
      setTimeout(run, 0);
    }
  }

  /** The Try panel redrawn and the session's runtime put on the canvas's renderer: the journey moved, restarted or arrived. */
  private tryRefresh(): void {
    this.canvas()?.tryRefresh?.();
  }

  /** Ends Try it from the mode's side (Open this step, a chunk that did not load, another definition): the canvas hands the answers back and disposes the run. */
  private endTryIt(): void {
    const canvas = this.canvas();
    if (canvas?.previewing) {
      canvas.previewing = false;
    }
  }

  /**
   * Try it starts in the Journeys workspace: the journey on the page runs on the canvas, from
   * the canvas's answers (kernel JSON). Made at once, as the canvas asks. With the chunk not in
   * yet, the form runs over the canvas's own preview meanwhile, and the journey takes over when
   * it comes, started from that store, which holds what was typed in between. A chunk that
   * cannot load is said once and Try it ends, so the next Try it loads it again.
   */
  private startTry(answers: Record<string, unknown>): BuilderTrySession {
    this.trying?.dispose();
    let journey: JourneyPreviewSession | undefined;
    let ended = false;
    /** The chunk's load this run waits on: one at a time, so a failure is said once. */
    let waiting = false;
    /** Set while the journey is first shown: the canvas is mid-paint and draws the panel itself. */
    let quiet = false;
    /** The page node Show me asked for before the journey was in. */
    let wantedPage: string | undefined;
    const plain = (): RenderHostRuntime | undefined => this.canvas()?.previewRuntime?.();
    const plainAnswers = (): Record<string, unknown> => {
      const values = plain()?.state().values as Record<string, unknown> | undefined;
      return values ? kernelJsonAnswers(values) : answers;
    };
    // The journey on the page is read each time: a Try it pressed while the designer builds
    // starts once it is built, and a designer built again is followed, its typed answers kept.
    const follow = (late: boolean): void => {
      const subject = this.builtEntry()?.previewSubject;
      if (ended || !subject) {
        return;
      }
      if (journey) {
        if (journey.subject !== subject) {
          journey.show(subject);
          // The map draws the designer built now.
          mountMap(this.canvas()?.shadowRoot);
        }
        return;
      }
      const make = this.tryMaker;
      if (!make) {
        if (!waiting) {
          waiting = true;
          this.prepareTry().then(
            () => {
              waiting = false;
              follow(true);
            },
            (error: unknown) => {
              waiting = false;
              if (!ended && !this.disposed) {
                this.options.onError?.("The journey preview could not be loaded", error);
                this.endTryIt();
              }
            }
          );
        }
        return;
      }
      const previewRuntime = this.options.previewRuntime;
      // The canvas's store, read now (it holds what was typed while the chunk was coming): its
      // typed answers alone are replayed, a calculation or a default worked out again.
      journey = make({
        form: this.options.form,
        ...(previewRuntime ? { runtime: previewRuntime } : {}),
        translations: () => this.options.translations?.(),
        formTranslations: () => formTranslationsOf(this.options.form),
        seed: plainAnswers(),
        typed: plain()?.state().dirty,
        onUpdate: () => {
          if (!quiet && this.trying === run) {
            this.tryRefresh();
          }
        },
        // A move, an answer that changes the path, an edit of the journey: the map's marks follow.
        onPath: () => syncMap(),
        onError: (message, cause) => this.options.onError?.(message, cause)
      });
      quiet = !late;
      try {
        journey.show(subject);
      } finally {
        quiet = false;
      }
      loadMap();
      // A page Show me asked for while the journey was coming.
      if (wantedPage !== undefined && journey.runtime) {
        const nodeId = wantedPage;
        wantedPage = undefined;
        goTo(journey.runtime, nodeId);
      }
    };
    /** Show me's move to a page of the path: at once and without hooks, as an error's move is (the runtime's own `"error"` direction). */
    const goTo = (runtime: JourneyPreviewRuntime, nodeId: string): void => {
      if (runtime.journeyView()?.pageId === nodeId || !runtime.goToPage) {
        return;
      }
      void runtime.goToPage(nodeId, { direction: "error" }).catch(() => undefined);
    };
    // The map in the Journey card: the real map, read-only, in the
    // card's kept slot, loaded when Try it first runs a journey (the map chunk is the designer's
    // to load, and Try it's own chunk imports none of it). The path it marks is the session's:
    // the step the person is on and the ways taken, set again on every move and every change.
    let map: JourneyMap | undefined;
    let mapLoading = false;
    const syncMap = (): void => {
      map?.setState(journey?.mapState());
    };
    /** The map into the card's slot (once), styled in the slot's root, drawn for the journey on the page, marked. */
    const mountMap = (within: ParentNode | null | undefined): void => {
      const slot = within?.querySelector<HTMLElement>(`[${TRY_MAP_SLOT}]`);
      const subject = this.builtEntry()?.mapSubject;
      if (!map || !slot || !subject) {
        return;
      }
      if (map.element.parentElement !== slot) {
        slot.append(map.element);
      }
      map.stylesInto(slot.getRootNode() as ShadowRoot | Document);
      if (!map.visible || map.subject !== subject) {
        map.show(subject);
      }
      syncMap();
    };
    const loadMap = (): void => {
      const designer = this.designer;
      // No page to put a map on (a server-side or headless run): the card is the same without it.
      if (map || mapLoading || ended || !journey || !designer || typeof document === "undefined") {
        return;
      }
      mapLoading = true;
      designer
        .createMap({
          layout: this.mapLayoutValue,
          readOnly: true,
          // The picture and its counts line only: the card's window has no room for
          // the direction and zoom buttons; the slot scrolls, and the map keeps the current step in view.
          controls: false,
          // The map's own stage is the card's window: it scrolls below the counts line, which stays
          // above it rather than over the steps; the map measures and scrolls within it alone.
          scroller: (element) => element.querySelector<HTMLElement>("[data-map-stage]"),
          onLayout: (layout) => {
            this.mapLayoutValue = normalizeJourneyMapLayout(layout);
            this.writeMapLayout();
            this.map?.setLayout(this.mapLayoutValue);
          },
          onError: (message, cause) => this.options.onError?.(message, cause)
        })
        .then(
          (made) => {
            mapLoading = false;
            if (ended || this.disposed) {
              made.dispose();
              return;
            }
            map = made;
            mountMap(this.canvas()?.shadowRoot);
          },
          (error: unknown) => {
            // Said once; the card is the same without its map, and the next Try it loads it again.
            mapLoading = false;
            if (!ended && !this.disposed) {
              this.options.onError?.("The journey map could not be loaded", error);
            }
          }
        );
    };
    /** The journey, once it is in: what Submit and the checks wait for when pressed while it loads. */
    const started = async (): Promise<JourneyPreviewSession | undefined> => {
      if (!journey && !ended) {
        await this.prepareTry().catch(() => undefined);
      }
      return journey;
    };
    const run: JourneyTryRun = {
      get journey() {
        return journey;
      },
      get pending() {
        return !journey && !ended;
      },
      get runtime() {
        return (journey?.runtime ?? plain()) as RenderHostRuntime;
      },
      answers: () => (journey?.runtime ? journey.answers() : plainAnswers()),
      submit: async () => (await started())?.submit() ?? { problems: [] },
      check: async () => (await started())?.check() ?? [],
      refresh: () => journey?.refresh(),
      restart: () => journey?.restart(),
      // Show me: the page a test's step is on, by the journey's page id; the preview runs it under its node.
      showPage: (pageId) => {
        const subject = this.builtEntry()?.previewSubject;
        if (!subject) {
          return;
        }
        if (journey && journey.subject !== subject) {
          journey.show(subject);
        }
        const nodeId = tryPageNodes(subject).find((node) => tryPageIdOf(subject, node) === pageId)?.id;
        if (nodeId === undefined) {
          return;
        }
        const runtime = journey?.runtime;
        if (!runtime) {
          // The journey is still on its way: it goes there once it is shown.
          wantedPage = nodeId;
          return;
        }
        goTo(runtime, nodeId);
      },
      // Record and Assert this name a page as a test does: the node the preview runs it under, read back as its page id.
      pageIdOf: (runtimePageId: string) => {
        const subject = journey?.subject ?? this.builtEntry()?.previewSubject;
        const node = subject ? tryPageNodes(subject).find((candidate) => candidate.id === runtimePageId) : undefined;
        return subject && node ? tryPageIdOf(subject, node) : undefined;
      },
      // An agent's way in: the journey once it runs (what Submit and the
      // checks wait for), and a page's node from its page id, the lookup Show me makes.
      ready: () => started().then(() => undefined),
      nodeIdOf: (pageId: string) => {
        const subject = journey?.subject ?? this.builtEntry()?.previewSubject;
        return subject ? tryPageNodes(subject).find((node) => tryPageIdOf(subject, node) === pageId)?.id : undefined;
      },
      follow: () => follow(true),
      drawn: (panel) => mountMap(panel),
      refreshMap: (changed, live) => {
        map?.refresh(changed, live);
        // The runtime's routes may have moved with the edit: the marks are the new path's.
        syncMap();
      },
      dispose: () => {
        ended = true;
        map?.dispose();
        map = undefined;
        journey?.dispose();
        journey = undefined;
        if (this.trying === run) {
          this.trying = undefined;
        }
      }
    };
    this.trying = run;
    follow(false);
    return run;
  }

  /**
   * The Print workspace's journey (BuilderMode.printSession): the journey the form opens as, run
   * by the same maker Try it's journey is (`prepareTry`) over the same subject, from `answers`
   * alone (every one replayed). Its own: Try it's run (`this.trying`) is never read, ended or
   * replaced, and the canvas never hears of it. The designer and the subject are made for it when
   * the Journeys workspace has not been opened yet; nothing of the run reaches the definition.
   */
  public printSession(answers: Record<string, unknown>): BuilderPrintSession {
    let journey: JourneyPreviewSession | undefined;
    let ended = false;
    const start = async (): Promise<void> => {
      try {
        const designer = await this.ensureDesigner();
        const make = await this.prepareTry();
        const subject = ended || this.disposed ? undefined : this.printSubject(designer);
        if (!subject) {
          return;
        }
        const previewRuntime = this.options.previewRuntime;
        journey = make({
          form: this.options.form,
          ...(previewRuntime ? { runtime: previewRuntime } : {}),
          translations: () => this.options.translations?.(),
          formTranslations: () => formTranslationsOf(this.options.form),
          seed: answers,
          onError: (message, cause) => this.options.onError?.(message, cause)
        });
        journey.show(subject);
      } catch {
        // A designer or a chunk that will not load: the form prints whole.
        journey?.dispose();
        journey = undefined;
      }
    };
    const started = start();
    return {
      get runtime() {
        return ended ? undefined : (journey?.runtime as RenderHostRuntime | undefined);
      },
      ready: () => started,
      dispose: () => {
        ended = true;
        journey?.dispose();
        journey = undefined;
      }
    };
  }

  /** What a print runs: the journey the form opens as, its designer built for it if it was not (the page on show is left as it is). */
  private printSubject(designer: JourneyDesigner): JourneyPreviewSubject | undefined {
    const id = findJourney({ journey: this.journeyConfiguration })?.id;
    const journey = id === undefined ? undefined : this.model.journeys.find((candidate) => candidate.id === id);
    if (!journey) {
      return undefined;
    }
    const entry = this.entryFor(journey.id);
    if (!entry.built) {
      this.build(entry, journey, designer);
    }
    return entry.previewSubject;
  }

  /** A `data-try-mode-action` pressed on the Journey card. */
  private onTryClick(action: string): void {
    const journey = this.trying?.journey;
    if (action === "restart") {
      // Its update redraws the panel and hands the canvas the new runtime.
      journey?.restart();
      return;
    }
    if (action === "open-step") {
      // The step the person is on, by its node; Try it ends first, so the workspace's own canvas is back.
      const nodeId = journey?.runtime?.journeyView()?.pageId;
      this.endTryIt();
      if (nodeId !== undefined) {
        // Focus to the bar's pressed Map | Step button at once (the button pressed went with the
        // Try panel); the step opens once the exit repaint has landed.
        this.focusViews();
        setTimeout(() => this.openStep(nodeId, false), 0);
      }
    }
  }

  /**
   * The Step view on `nodeId`, the step selected (the map's Open and Enter on a step): through
   * the journey's unsaved-edits guard like any selection, so a refusal leaves the map up. The
   * control pressed goes with the map (`hadFocus`), so focus lands on the bar's Step button.
   */
  private openStep(nodeId: string, hadFocus: boolean): void {
    const entry = this.builtEntry();
    if (!entry || !entry.controller.requestSelect(nodeId)) {
      return;
    }
    if (this.viewValue === "step") {
      entry.step?.show(nodeId);
    } else {
      this.stepAt = nodeId;
      this.view = "step";
    }
    if (hadFocus) {
      this.focusViews();
    }
  }

  /** The Step view of the journey on the page, while it is up. */
  private stepNow(): JourneyStepView | undefined {
    const selected = this.model.selected();
    const step = selected ? this.entries.get(selected.id)?.step : undefined;
    return step?.up() ? step : undefined;
  }

  /** Tells the shell what the Step view answers (the inspector's routing, the Undo) may have moved. */
  private stepChanged(): void {
    this.syncPanels();
    for (const listener of [...this.inspectionListeners]) {
      listener();
    }
    for (const listener of [...this.historyListeners]) {
      listener();
    }
  }

  /** Runs `run` once the form field the inspector edits has no unsaved edit (the shell's guard), at once when the shell has none. */
  private holdForInspector(run: () => void): void {
    const hold = this.context?.holdForInspector;
    if (hold) {
      hold.call(this.context, run);
    } else {
      run();
    }
  }

  /**
   * Brings the Step view up on the journey on the page, or puts it away on every other: the one
   * place the controller's canvas options change for it. Called whenever the canvas is chosen
   * again, so the view follows `view`, the journey and the designer being built.
   */
  private syncStep(): void {
    const selected = this.model.selected();
    const wanted = selected && this.viewValue === "step" ? this.entries.get(selected.id) : undefined;
    for (const entry of this.entries.values()) {
      if (entry !== wanted || !entry.built) {
        entry.step?.leave();
      }
    }
    const designer = this.designer;
    const base = wanted?.design?.builderOptions;
    if (wanted?.built && designer && base) {
      if (!wanted.step) {
        wanted.step = designer.stepView({
          form: this.options.form,
          journey: wanted.controller,
          journeyId: () => wanted.id,
          base,
          hold: (run) => this.holdForInspector(run),
          changed: () => this.stepChanged()
        });
        // The Undo's own notices (a step made on either controller) reach the shell through the mode's.
        wanted.step.subscribeHistory(() => {
          for (const listener of [...this.historyListeners]) {
            listener();
          }
        });
      }
      const at = this.stepAt;
      this.stepAt = undefined;
      wanted.step.enter(at);
    }
  }

  /**
   * The map's Delete: the step selected (through the unsaved-edits guard), then the canvas's own
   * delete confirmation, the one a page gets from the Pages view's selection bar, which names what
   * else in the journey goes with it. The step goes as one undo step once confirmed.
   */
  private deleteStep(nodeId: string): void {
    const controller = this.builtEntry()?.controller;
    if (controller?.requestSelect(nodeId)) {
      this.canvas()?.runAction?.("delete");
    }
  }

  // --- Go to rules in the Logic workspace -------------------

  /** Tells the Logic surface the journeys moved, or that its writes can run now. A listener is told once per change. */
  private notifyLogic(): void {
    const configuration = this.model.configuration;
    const ready = this.logicReady();
    const seen = this.logicSeen;
    if (seen !== undefined && seen.configuration === configuration && seen.ready === ready) {
      return;
    }
    this.logicSeen = { configuration, ready };
    this.logicVersion += 1;
    for (const listener of [...this.logicListeners]) {
      listener();
    }
  }

  private logicReady(): boolean {
    return this.designer !== undefined && this.authoringReady && !this.disposed;
  }

  /** The journey's entry with its designer built, built now when it is not (any journey, not only the one on the page); `undefined` until the designer is in. */
  private logicEntry(journeyId: string): JourneyEntry | undefined {
    const designer = this.designer;
    const journey = this.model.journeys.find((listed) => listed.id === journeyId);
    if (!designer || !this.authoringReady || !journey || this.disposed) {
      return undefined;
    }
    const entry = this.entryFor(journeyId);
    if (!entry.built) {
      this.build(entry, journey, designer);
    }
    return entry;
  }

  /** The nodes a written route stands for: its page's and its own, and the route nodes of the page in tree order (written or not). */
  private locateRoute(entry: JourneyEntry, ref: Pick<LogicRouteRef, "pageId"> & { routeIndex?: number | undefined }):
    | { pageNode: ComponentNode; routeNodeId: string | undefined; treeRoutes: ComponentNode[]; placed: { nodeId: string; pageId: string; routes: readonly string[] } }
    | undefined {
    const placed = entry.design?.view().check.placement.pages.find((page) => page.pageId === ref.pageId);
    if (!placed) {
      return undefined;
    }
    const tree = entry.controller.snapshot();
    const pageNode = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).find((node) => node.id === placed.nodeId);
    if (!pageNode) {
      return undefined;
    }
    const treeRoutes = (pageNode.children?.[JOURNEY_ROUTES_SLOT] ?? []).filter((node) => node.type === JOURNEY_ROUTE_TYPE);
    const routeNodeId = ref.routeIndex !== undefined ? placed.routes[ref.routeIndex] : undefined;
    return { pageNode, routeNodeId: routeNodeId !== undefined && routeNodeId !== "" ? routeNodeId : undefined, treeRoutes, placed };
  }

  /** A page id of the journey, or the end, as the node id a route stores; `undefined` for a page the journey does not have. */
  private routeTargetNode(entry: JourneyEntry, to: string): string | undefined {
    if (to === JOURNEY_END) {
      return JOURNEY_END;
    }
    const placed = entry.design?.view().check.placement.pages.find((page) => page.pageId === to);
    return placed !== undefined && placed.nodeId !== "" ? placed.nodeId : undefined;
  }

  /** The host the Logic workspace edits this mode's Go to rules through; the controller's own undo takes each write back whole. */
  private logicHost(): LogicJourneyHost {
    const blank = (when: unknown): boolean => when === undefined || when === null || (typeof when === "string" && when.trim() === "");
    return {
      version: () => this.logicVersion,
      journeys: () => {
        const configuration = this.model.configuration;
        const memo = this.logicMemo;
        if (memo !== undefined && memo.configuration === configuration) {
          return memo.journeys;
        }
        const journeys = this.model.journeys;
        this.logicMemo = { configuration, journeys };
        return journeys;
      },
      ready: () => this.logicReady(),
      prepare: () =>
        this.ensureDesigner().then(
          () => {
            this.notifyLogic();
            return this.logicReady();
          },
          () => false
        ),
      subscribe: (listener) => {
        this.logicListeners.add(listener);
        return () => {
          this.logicListeners.delete(listener);
        };
      },
      select: (ref) => {
        const entry = this.logicEntry(ref.journeyId);
        const found = entry ? this.locateRoute(entry, ref) : undefined;
        const nodeId = found?.routeNodeId ?? found?.pageNode.id;
        if (entry && nodeId !== undefined && entry.controller.selectedComponentId() !== nodeId) {
          entry.controller.select(nodeId);
        }
      },
      update: (ref, change) => this.withFormStep(() => {
        const entry = this.logicEntry(ref.journeyId);
        const found = entry ? this.locateRoute(entry, ref) : undefined;
        if (!entry || !found?.routeNodeId) {
          return false;
        }
        const edits: Array<{ componentId: string; propertyPath: string; value: unknown }> = [];
        if (change.to !== undefined) {
          const to = this.routeTargetNode(entry, change.to);
          if (to === undefined) {
            return false;
          }
          edits.push({ componentId: found.routeNodeId, propertyPath: "to", value: to });
        }
        if (change.when !== undefined) {
          edits.push({ componentId: found.routeNodeId, propertyPath: "when", value: change.when.trim() === "" ? undefined : change.when });
        }
        if (edits.length > 0) {
          entry.controller.setProperties(edits);
        }
        return true;
      }),
      create: (spec) => this.withFormStep(() => {
        const entry = this.logicEntry(spec.journeyId);
        const found = entry ? this.locateRoute(entry, { pageId: spec.pageId }) : undefined;
        const to = entry ? this.routeTargetNode(entry, spec.to) : undefined;
        if (!entry || !found || to === undefined) {
          return undefined;
        }
        // Before the step's first rule with no condition, which would win over it for good; else last.
        const committed = this.model.journeys.find((journey) => journey.id === spec.journeyId)?.pages.find((page) => page.id === spec.pageId);
        const firstBlank = (committed?.routes ?? []).findIndex((route) => blank(route.when));
        const before = firstBlank >= 0 ? found.placed.routes[firstBlank] : undefined;
        const index = before !== undefined ? found.treeRoutes.findIndex((node) => node.id === before) : -1;
        const taken = new Set<string>(this.formIds());
        const stack: ComponentNode[] = [entry.controller.snapshot()];
        while (stack.length > 0) {
          const node = stack.pop() as ComponentNode;
          taken.add(node.id);
          for (const group of Object.values(node.children ?? {})) {
            stack.push(...group);
          }
        }
        let n = 1;
        while (taken.has(`${JOURNEY_ROUTE_TYPE}_${n}`)) {
          n += 1;
        }
        const id = `${JOURNEY_ROUTE_TYPE}_${n}`;
        const node: ComponentNode = {
          id,
          type: JOURNEY_ROUTE_TYPE,
          configuration: { to, ...(spec.when !== undefined && spec.when.trim() !== "" ? { when: spec.when } : {}) }
        };
        const result = entry.controller.insertComponents([{ node, parentId: found.pageNode.id, slotId: JOURNEY_ROUTES_SLOT, ...(index >= 0 ? { index } : {}) }]);
        if (!result.ok) {
          return undefined;
        }
        const routeIndex = this.locateRoute(entry, { pageId: spec.pageId })?.placed.routes.indexOf(id) ?? -1;
        return routeIndex >= 0 ? { journeyId: spec.journeyId, pageId: spec.pageId, routeIndex } : undefined;
      }),
      move: (ref, delta) => this.withFormStep(() => {
        const entry = this.logicEntry(ref.journeyId);
        const found = entry ? this.locateRoute(entry, ref) : undefined;
        const neighbour = found?.placed.routes[ref.routeIndex + delta];
        if (!entry || !found?.routeNodeId || neighbour === undefined || neighbour === "") {
          return undefined;
        }
        const at = found.treeRoutes.findIndex((node) => node.id === neighbour);
        if (at < 0 || !entry.controller.move(found.routeNodeId, { parentId: found.pageNode.id, slotId: JOURNEY_ROUTES_SLOT, index: delta < 0 ? at : at + 1 })) {
          return undefined;
        }
        return { journeyId: ref.journeyId, pageId: ref.pageId, routeIndex: ref.routeIndex + delta };
      }),
      remove: (ref) => this.withFormStep(() => {
        const entry = this.logicEntry(ref.journeyId);
        const found = entry ? this.locateRoute(entry, ref) : undefined;
        if (!entry || !found?.routeNodeId) {
          return false;
        }
        try {
          entry.controller.remove(found.routeNodeId);
          return true;
        } catch (error) {
          this.options.onError?.("The rule could not be removed", error);
          return false;
        }
      }),
      askedThrough: (journeyId, pageId) => {
        const entry = this.logicEntry(journeyId);
        const placed = entry?.design?.view().check.placement.pages.find((page) => page.pageId === pageId);
        if (!entry || !placed) {
          return undefined;
        }
        const at = (entry.controller.previewSnapshot().children?.[JOURNEY_PAGES_SLOT] ?? []).findIndex((node) => node.id === placed.nodeId);
        return at < 0 ? undefined : this.askedThroughPage(entry, at);
      },
      takePending: () => {
        const pending = this.logicPending;
        this.logicPending = undefined;
        return pending !== undefined && Date.now() - pending.at < LOGIC_REQUEST_LIFE_MS ? pending.request : undefined;
      },
      onOpen: (listener) => {
        this.logicOpenListeners.add(listener);
        return () => {
          this.logicOpenListeners.delete(listener);
        };
      }
    };
  }

  /**
   * A write the Logic workspace makes on a journey's own controller, as a step of the form's
   * history too. While Logic is on the page the form's controller is the one behind the bar's Undo,
   * Ctrl+Z and `undo()`, which cannot reach the journey's: without this step an Undo there would
   * quietly take back the last unrelated form edit and leave the rule as written. The step is the
   * journeys' block as it stood before and after ({@link blockCommand}), put back by Undo and
   * Redo; the journey's own Undo (in the Journeys mode) still takes the rule back there.
   */
  private withFormStep<T>(write: () => T): T {
    const before = this.model.configuration;
    const result = write();
    const after = this.model.configuration;
    if (after !== before && !sameData(after, before)) {
      (this.options.form as { recordStep?(command: BuilderCommand): void }).recordStep?.(this.blockCommand(before, after));
    }
    return result;
  }

  /**
   * Whether the shell offers the Logic workspace (the `features` list, `hidden-workspaces`): the
   * map's New rule and a click on a rule's label ask for it, and a shell that refuses leaves
   * them dead, so the map does not offer them. A host that cannot say counts as offering it.
   */
  private logicAvailable(): boolean {
    const host = this.context?.host as { availableWorkspaces?: () => readonly string[] } | undefined;
    return typeof host?.availableWorkspaces !== "function" || host.availableWorkspaces().includes("logic");
  }

  /**
   * Asks for the Logic workspace to edit a rule: heard at once by a surface on the page, else held
   * a few seconds for the one the workspace is loading. The shell is asked for the workspace by the
   * event a panel uses; a shell that has no Logic (the feature off) leaves the request to expire.
   */
  private requestLogic(request: LogicOpenRequest): void {
    const listeners = [...this.logicOpenListeners];
    if (listeners.length > 0) {
      this.logicPending = undefined;
      for (const listener of listeners) {
        listener(request);
      }
    } else {
      this.logicPending = { request, at: Date.now() };
    }
    const root = this.context?.root;
    if (typeof root?.dispatchEvent === "function") {
      root.dispatchEvent(new CustomEvent("builder-open-workspace", { bubbles: true, composed: true, detail: { workspace: "logic" } }));
    }
  }

  /** The map's click on a rule's label (or its stub): that Go to rule in the Logic editor. A route with no target yet is not a written rule, so only the selection happens. */
  private openRuleFromMap(nodeId: string): void {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    const placement = entry?.built ? entry.design?.view().check.placement.pages : undefined;
    for (const page of placement ?? []) {
      const routeIndex = page.routes.indexOf(nodeId);
      if (routeIndex >= 0 && selected) {
        this.requestLogic({ kind: "rule", ref: { journeyId: selected.id, pageId: page.pageId, routeIndex } });
        return;
      }
    }
  }

  /**
   * A step's Go to rules as its Logic tab lists them: each opens in the Logic editor as a
   * click on its label on the map does, and New rule makes one to the next step, as the map's
   * does. Without the Logic workspace they are listed with neither.
   */
  private stepWays(nodeId: string): BuilderModeWays | undefined {
    const selected = this.model.selected();
    const entry = this.builtEntry();
    const view = entry?.controller.editedNode(nodeId)?.type === JOURNEY_PAGE_TYPE ? entry.design?.view() : undefined;
    const rules = selected && view ? this.designer?.stepRules(view, nodeId, selected.id) : undefined;
    if (!selected || !rules) {
      return undefined;
    }
    const logic = this.logicAvailable();
    const journeyId = selected.id;
    const { pageId, next } = rules;
    return {
      note: rules.note,
      rows: rules.rows.map(({ title, reads, routeIndex }) => ({
        title,
        ...(reads !== undefined ? { reads } : {}),
        ...(logic && routeIndex !== undefined ? { open: () => this.requestLogic({ kind: "rule", ref: { journeyId, pageId, routeIndex } }) } : {})
      })),
      ...(logic && next !== undefined ? { newRule: { label: rules.newRule, run: () => this.requestLogic({ kind: "new", journeyId, pageId, to: next }) } } : {})
    };
  }

  /** The map's New rule: a new Go to rule from the step to the next one, in the Logic editor, written when it is applied. */
  private newRuleFromMap(fromNodeId: string, toNodeId: string): void {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    const pages = entry?.built ? entry.design?.view().check.placement.pages : undefined;
    const from = pages?.find((page) => page.nodeId === fromNodeId);
    const to = pages?.find((page) => page.nodeId === toNodeId);
    if (selected && from && to) {
      this.requestLogic({ kind: "new", journeyId: selected.id, pageId: from.pageId, to: to.pageId });
    }
  }

  /** The journey on the page's controller, when its designer is built: what the map selects through. */
  private builtEntry(): JourneyEntry | undefined {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    return entry?.built ? entry : undefined;
  }

  /**
   * The flow map, made once its chunk is in: the designer loads the chunk (retried
   * after a failure). A map arriving after `dispose` is dropped at once, so it never observes
   * or draws anything.
   */
  private ensureMap(): Promise<JourneyMap> {
    if (this.map) {
      return Promise.resolve(this.map);
    }
    if (this.mapLoad) {
      return this.mapLoad;
    }
    const designer = this.designer;
    if (!designer) {
      return Promise.reject(new Error("The Journeys designer is not loaded"));
    }
    const load = designer.createMap({
      layout: this.mapLayoutValue,
      onSelect: (nodeId) => {
        this.builtEntry()?.controller.requestSelect(nodeId);
      },
      // A rule's label opens the Go to rule in Logic, in the layout of any other rule.
      onOpenRule: (nodeId) => this.openRuleFromMap(nodeId),
      rulesEditable: () => this.logicAvailable(),
      // Open: the Step view on that step.
      onOpen: (nodeId) => this.openStep(nodeId, this.map !== undefined && holdsFocus(this.map.element)),
      edit: {
        addStep: (afterNodeId) => void this.builtEntry()?.controller.requestAddAfter(JOURNEY_PAGE_TYPE, afterNodeId),
        newRule: (fromNodeId, toNodeId) => this.newRuleFromMap(fromNodeId, toNodeId),
        moveStep: (nodeId, delta) => void this.builtEntry()?.controller.requestMoveBy(nodeId, delta),
        duplicateStep: (nodeId) => void this.builtEntry()?.controller.requestDuplicate(nodeId),
        deleteStep: (nodeId) => this.deleteStep(nodeId)
      },
      onLayout: (layout) => {
        this.mapLayoutValue = normalizeJourneyMapLayout(layout);
        this.writeMapLayout();
      },
      onError: (message, cause) => this.options.onError?.(message, cause)
    });
    this.mapLoad = load;
    this.syncViews();
    load.then(
      (map) => {
        if (this.mapLoad !== load || this.disposed) {
          map.dispose();
          return;
        }
        this.mapLoad = undefined;
        this.map = map;
        // A layout chosen while the chunk was coming.
        map.setLayout(this.mapLayoutValue);
        this.syncViews();
      },
      () => {
        if (this.mapLoad === load) {
          this.mapLoad = undefined;
          this.syncViews();
        }
      }
    );
    return load;
  }

  /** What the canvas shows while the map's chunk loads. */
  private ensureMapNote(): HTMLElement {
    if (!this.mapNote) {
      const note = document.createElement("p");
      note.className = "journey-load-note";
      note.setAttribute("role", "status");
      note.setAttribute("data-journey-map-note", "");
      note.textContent = "Drawing the map…";
      this.mapNote = note;
    }
    return this.mapNote;
  }

  /** The viewer's layout for the map, read from the shell's `persist-panels` key when it names one it has not read. */
  private readMapLayout(context: BuilderModeContext): void {
    const key = (context.host as { persistPanels?: unknown } | undefined)?.persistPanels;
    if (typeof key !== "string") {
      // No key, nothing remembered; a key given later is read afresh.
      this.mapPersistKey = undefined;
      return;
    }
    if (key === this.mapPersistKey) {
      return;
    }
    this.mapPersistKey = key;
    const remembered = readJourneyMapLayout(key);
    if (remembered) {
      this.mapLayoutValue = remembered;
      this.map?.setLayout(remembered);
    }
  }

  /** Remembers the map's layout under the `persist-panels` key the host gives now, if any (it may have dropped or changed it since it was read). */
  private writeMapLayout(): void {
    const key = (this.context?.host as { persistPanels?: unknown } | undefined)?.persistPanels;
    if (typeof key === "string") {
      writeJourneyMapLayout(key, this.mapLayoutValue);
    }
  }

  private ensureAddHost(): HTMLElement | undefined {
    if (!this.addHost && typeof document !== "undefined") {
      const host = document.createElement("div");
      host.setAttribute("data-journey-add-popover", "");
      host.hidden = true;
      this.addHost = host;
    }
    return this.addHost;
  }

  private ensureViewsGroup(): HTMLElement | undefined {
    if (!this.viewsGroup && typeof document !== "undefined") {
      const group = document.createElement("div");
      // The shell draws a data-segmented child as a segmented control.
      group.setAttribute("data-segmented", "");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", builderText("journey.mode.view.group", undefined, this.words()));
      group.setAttribute("data-journey-views", "");
      group.hidden = true;
      group.innerHTML =
        // Worded in syncViews below, from the builder's text tables.
        '<button type="button" data-journey-view="map" aria-pressed="true"></button>' +
        '<button type="button" data-journey-view="step" aria-pressed="false"></button>';
      group.addEventListener("click", (event) => {
        const choice = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-journey-view]")?.dataset.journeyView;
        if (choice === "map" || choice === "step") {
          this.view = choice;
        }
      });
      this.viewsGroup = group;
      this.syncViews();
    }
    return this.viewsGroup;
  }

  /** The bar's steady control, the pressed Map | Step button: where focus goes when the control holding it goes away. */
  private focusViews(): void {
    this.viewsGroup?.querySelector<HTMLElement>('[data-journey-view][aria-pressed="true"]')?.focus();
  }

  /**
   * Map | Step: while there is a journey on the page and a designer to show it; busy while the
   * map's chunk loads. A journey opens on its map, whatever its number of steps: a new journey
   * is one empty step, and its errors show from the start. A journey with no step (a host's
   * file; the builder makes none) has no step to show: the Step button hides, and the map
   * stays up.
   */
  private syncViews(): void {
    const group = this.viewsGroup;
    if (!group) {
      return;
    }
    const selected = this.model.selected();
    group.hidden = !selected || !this.designer;
    // A true/false ARIA state: written as "true", as the shell writes it, never as the empty
    // value `toggleAttribute` would leave (which assistive technology reads as not busy).
    if (this.mapLoad !== undefined) {
      group.setAttribute("aria-busy", "true");
    } else {
      group.removeAttribute("aria-busy");
    }
    const empty = selected !== undefined && selected.pages.length === 0;
    if (empty && this.viewValue !== "map") {
      this.viewValue = "map";
      this.applyView();
    }
    const groupLabel = builderText("journey.mode.view.group", undefined, this.words());
    if (group.getAttribute("aria-label") !== groupLabel) {
      group.setAttribute("aria-label", groupLabel);
    }
    for (const button of group.querySelectorAll<HTMLElement>("[data-journey-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.journeyView === this.viewValue));
      // Worded again as the builder's language moves: written only when it did, since the shell watches this group.
      const words = VIEW_WORDS[button.dataset.journeyView as JourneyModeView] as (typeof VIEW_WORDS)[JourneyModeView] | undefined;
      if (words) {
        const title = builderText(words.title, undefined, this.words());
        const label = builderText(words.label, undefined, this.words());
        if (button.title !== title) {
          button.title = title;
        }
        if (button.textContent !== label) {
          button.textContent = label;
        }
      }
      if (button.dataset.journeyView === "step") {
        button.hidden = empty;
      }
    }
  }

  /** The builder's words (its locale and catalog) for the mode's own chrome. */
  private words(): BuilderTextOptions {
    return { locale: this.locale(), catalog: this.textCatalog?.() };
  }

  /** The canvas: the journey's map or its step, or, with no journey, the empty state in its place. */
  private applyView(): void {
    const context = this.context;
    if (!context || !this.active) {
      return;
    }
    const selected = this.model.selected();
    // The Step view up or put away first: the sheet the canvas shows below is the one it draws.
    this.syncStep();
    if (selected) {
      const entry = this.entries.get(selected.id);
      // A journey on the page: Try it's chunk comes ahead, so Try it starts on the journey, and
      // a Try it running follows the journey's designer (built since, or built again).
      if (entry?.built) {
        this.warmTry(selected.id);
        this.trying?.follow();
      }
      if (this.viewValue === "map" && entry?.built && entry.mapSubject && typeof document !== "undefined") {
        this.applyMap(context, entry.mapSubject);
        return;
      }
      this.map?.hide();
      context.showCanvasSurface(undefined);
      return;
    }
    this.map?.hide();
    // A new journey opens on its map.
    if (this.viewValue !== "map") {
      this.viewValue = "map";
      this.syncViews();
    }
    const designer = this.designer;
    if (!designer || typeof document === "undefined") {
      return;
    }
    this.emptyState ??= designer.createEmptyState({ onAdd: (anchor) => void this.openAdd(anchor).catch(() => undefined) });
    this.emptyState.update({ questionCount: designer.questionCount() });
    context.showCanvasSurface(this.emptyState.element);
  }

  /**
   * The Map view: the map on the canvas, put there before it is shown so it measures the room
   * it has; while its chunk loads, a note in its place. A load that fails is reported and tried
   * again on the next Map; the view goes to the Step view only if Map is still what was asked
   * for. The map has its own zoom and no Try it: Try it runs from the pages.
   */
  private applyMap(context: BuilderModeContext, subject: JourneyMapSubject): void {
    const map = this.map;
    if (map) {
      // The map has its own + / -: the canvas bar shows no zoom tools, and no Try it
      // (a surface opts in with `tryable`), so Try it runs from the pages.
      // Its selected step has a bar of its own, so the canvas's is left off (`selectionBar`).
      context.showCanvasSurface(map.element, { zoomable: false, selectionBar: false });
      map.show(subject);
      return;
    }
    context.showCanvasSurface(this.ensureMapNote(), { zoomable: false });
    const load = this.ensureMap();
    // Once per load: another pass while the chunk is coming (a form change, another journey)
    // waits on the same load, so a failure is reported once.
    if (load === this.mapAwaited) {
      return;
    }
    this.mapAwaited = load;
    load.then(
      () => {
        if (this.mapAwaited === load) {
          this.mapAwaited = undefined;
        }
        if (!this.disposed) {
          this.applyView();
        }
      },
      (error: unknown) => {
        if (this.mapAwaited === load) {
          this.mapAwaited = undefined;
        }
        // A builder taken off the page while the chunk came (a test's teardown, a page that moved on) has nobody to tell
        // and nothing to redraw: reporting would dispatch an event on a host whose document may be gone, and the
        // rejection of that, unhandled, ends the page's run.
        if (this.disposed || !context.host.isConnected) {
          return;
        }
        this.options.onError?.("The journey map could not be loaded", error);
        if (this.viewValue === "map") {
          this.view = "step";
        } else {
          this.applyView();
        }
      }
    );
  }
}

/**
 * What stands for the whole form among the Opens-as choices: "form", unless a journey from a
 * file has that id (the builder never gives one it, RESERVED_JOURNEY_IDS), then a value no
 * journey has, so each choice keeps a value of its own.
 */
function wholeFormValue(journeys: readonly Journey[]): string {
  let whole = "form";
  for (let n = 1; journeys.some((journey) => journey.id === whole); n += 1) {
    whole = `form:whole-${n}`;
  }
  return whole;
}

/** The Journeys designer as a builder mode: register it with `<datum-builder>.addMode()`. */
export function createJourneyBuilderMode(options: JourneyBuilderModeOptions): JourneyBuilderMode {
  return new JourneyBuilderModeImpl(options);
}

/**
 * The journeys' block `current` with the change a history step made `from` one state `to`
 * another carried onto it: exactly `to` while the block still stands as `from` did, else the
 * journeys and pages the step touched are changed, added or removed and the rest is kept.
 */
function carryJourneyBlock(current: JourneyConfiguration | undefined, from: JourneyConfiguration | undefined, to: JourneyConfiguration | undefined): JourneyConfiguration | undefined {
  if (sameData(current, from)) {
    return to === undefined ? undefined : structuredClone(to);
  }
  const carried = carryChange(current, from, to) as JourneyConfiguration | undefined;
  if (!carried || !Array.isArray(carried.journeys)) {
    return carried;
  }
  const fromJourneys = Array.isArray(from?.journeys) ? from.journeys : [];
  const toJourneys = Array.isArray(to?.journeys) ? to.journeys : [];
  const journeys = carryMembership(carried.journeys, fromJourneys, toJourneys).map((journey) => {
    if (!hasId(journey)) {
      return journey;
    }
    const was = fromJourneys.find((entry) => hasId(entry) && entry.id === journey.id) as { pages?: unknown } | undefined;
    const now = toJourneys.find((entry) => hasId(entry) && entry.id === journey.id) as { pages?: unknown } | undefined;
    const held = (journey as { pages?: unknown }).pages;
    if (!was || !now || !Array.isArray(held) || !Array.isArray(was.pages) || !Array.isArray(now.pages)) {
      return journey;
    }
    const pages = carryMembership(held, was.pages, now.pages);
    return pages.length === held.length && pages.every((page, index) => page === held[index]) ? journey : { ...journey, pages };
  });
  return { ...carried, journeys } as JourneyConfiguration;
}
