import type { ComponentDefinition } from "../../core/schema/contracts.js";
import type { ComponentNode, FormDefinition, LocalizationConfiguration } from "../../core/schema/types.js";
import { parseSimulatedOptions } from "../controller/simulated-options.js";
import { findJourney, readJourneys } from "../../core/schema/journey.js";
import type { FormChromeConfiguration } from "../../core/schema/form-chrome.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import type { DefinitionBudget } from "../definition-budget.js";
import { BuilderWords, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import type { OutsideDocument } from "../../core/localization/locale-documents.js";
import type { ValuePathMove } from "../formula/rename.js";
import { definitionSizeProblem } from "./definition-size.js";
import { formulaFunctionRows } from "../formula/feel-functions.js";
import type { FormulaFunctionsSource } from "./builder-panels.js";
import type { TryItPdfSource, TryItServerChecksSource } from "./try-it-types.js";
import type { TrySubmissionUpdate } from "../controller/try-submission.js";
import { buildThemeStyleVars } from "../../render/core/token-style-vars.js";
import type { BuilderThemeDefinition } from "./builder-theme-registry.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import type { DataSourceResolver } from "../../render/core/component-options.js";
import type { DataSourceSet } from "../../core/schema/contracts.js";
import type { AdapterEntry, LiveAssets, LiveBinding } from "../../render/live/contract.js";
import {
  BuilderController,
  type BuilderChangeReason,
  type BuilderComponentType,
  type BuilderRenameStepped,
  type BuilderBindingOption,
  type BuilderLocaleOption,
  type FormIdentity,
  type LeaveGuard,
  type LocaleChanges,
  type TranslatableText
} from "../controller/builder-controller.js";
import type { HostValidationCode } from "../property-editor/inspector-model.js";
import type { BuilderMutationEvent } from "../tree-editor/tree-editor.js";
import { BUILDER_DRAG_MIME_TYPE, writeDragPayload } from "../drag-drop/html5-drag-drop.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import { CONFIRM_STYLES, FOCUS_AND_SELECT_STYLES, ICON_BUTTON_STYLES, PANEL_BOX_STYLES, SHARED_PATTERN_STYLES, TIP_STYLES, paletteIconHtml } from "./builder-shared.js";
import { adoptBuilderHostControlStyles, isBuilderHostControlRoot } from "./host-control-styles.js";
import { escapeHtml } from "../../render/core/escape-html.js";
import { plainHostContext } from "../../core/state/host-context.js";
import { defaultIconSet, renderIcon, type IconSet } from "../../render/icons/icon-set.js";
import type { DatumIconName } from "../../render/icons/icon-names.js";
import {
  DATUM_LOCALE_SELECT_TAG,
  type DatumLocaleSelectElement
} from "../../render/web-component/locale-select-element.js";
import {
  PRIMARY_BUILDER_MODE,
  type BuilderDocument,
  type BuilderDocumentChangeDetail,
  type BuilderMode,
  type BuilderModeChangeDetail,
  type BuilderModeContext,
  type BuilderModeFormFields,
  type BuilderModeInspection,
  type CanvasSurfaceOptions,
  type BuilderModeErrorDetail,
  type BuilderOpenModeDetail
} from "./builder-modes.js";
import { addressOf, resolveText, type FormTranslations } from "../../core/localization/translations.js";
import { declaredDefaultLocale, localeDisplayName, supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import {
  DATUM_BUILDER_CANVAS_TAG,
  DATUM_BUILDER_FORM_PANEL_TAG,
  DATUM_BUILDER_PROPERTIES_TAG,
  DATUM_BUILDER_TOOLBAR_TAG,
  defineBuilderPanels,
  DatumBuilderCanvasElement,
  DatumBuilderFormPanelElement,
  type BuilderOpenPanelDetail,
  type FormPanelModeSettings,
  DatumBuilderPropertiesElement,
  DatumBuilderToolbarElement
} from "./builder-panels.js";
import {
  DATUM_BUILDER_OUTLINE_TAG,
  defineBuilderOutline,
  DatumBuilderOutlineElement
} from "./builder-outline.js";
import {
  DATUM_BUILDER_FORM_FIELDS_TAG,
  defineBuilderFormFields,
  DatumBuilderFormFieldsElement
} from "./builder-form-fields-panel.js";
// The Header & footer and Variables panels are chunks of their own: types only from
// their modules, the values through the loaders, so neither lands in the builder's entry chunk.
import type { DatumBuilderChromePanelElement } from "./builder-chrome-panel.js";
import type { DatumBuilderVariablesPanelElement } from "./builder-variables-panel.js";
import type { DatumBuilderTestsPanelElement } from "./builder-tests-panel.js";
import type {
  BuilderLogicOpenTestDetail,
  BuilderLogicWriteTestDetail,
  BuilderTestsOpenRuleDetail,
  BuilderTestsStatusDetail,
  CanvasScenarioShowing,
  TestsAssertSnapshot,
  TestsCanvasRecording,
  TestsEntryModel,
  TestsPin,
  TestsPinsOf,
  TestsRecordListener
} from "../form-tests/tests-model.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { FormTestConfiguration } from "../../core/form-tests/form-test-types.js";
import { CHROME_PANEL_TAG as DATUM_BUILDER_CHROME_PANEL_TAG, chromePanelLoaded, loadChromePanel } from "./chrome-panel-loader.js";
import { VARIABLES_PANEL_TAG as DATUM_BUILDER_VARIABLES_PANEL_TAG, loadVariablesPanel, variablesPanelLoaded } from "./variables-panel-loader.js";
import { TESTS_PANEL_TAG as DATUM_BUILDER_TESTS_PANEL_TAG, loadTestsPanel, testsPanelLoaded } from "./tests-panel-loader.js";
import { PANEL_DRAWER_WIDTHS, PROPS_MAX, PROPS_MIN, SIDE_MAX, SIDE_MIN, readPanelMemory, writePanelMemory, type PanelMemory, type RememberedPanel, readSchemeMemory, writeSchemeMemory, type BuilderScheme } from "./panel-memory.js";
import { DATUM_DARK_BUILDER_THEME } from "./studio-dark-theme.js";
import { studioTokenDeclarations, studioTokenRules } from "./studio-tokens.js";
import { PHONE_BOTTOM_BAR_MAX, PHONE_BOTTOM_ORDER, PHONE_SHELL_STYLES, RESULTS_SHEET_STYLES } from "./phone-styles.js";
import { attachSheetGestures, sheetBodyScrolled } from "./sheet-gestures.js";
import { PHONE_MENU_ICONS, phoneMenuButtonName, phoneMenuSectionsHtml, type PhoneMenuRow, type PhoneMenuSection } from "./phone-menu.js";
import { loadLogicSurface } from "../logic/logic-loader.js";
import { loadDataSurface } from "../data/data-loader.js";
import { loadLanguagesSurface } from "../languages/languages-loader.js";
import { loadPrintSurface } from "../print/print-loader.js";
import { loadOverviewSurface } from "../overview/overview-loader.js";
import {
  featureOn,
  normalizeBuilderFeatures,
  panelAllowed,
  parseBuilderFeatures,
  workspaceAllowed,
  type BuilderFeature,
  type BuilderFeatureSet
} from "./builder-features.js";
import { loadCommandPalette } from "../palette/palette-loader.js";
import type { DatumBuilderPaletteElement } from "../palette/command-palette.js";
import type { BuilderCommand, BuilderCommandSource } from "../palette/palette-filter.js";
import type { DatumBuilderOverviewElement, OverviewAddDetail, OverviewOpenDetail, OverviewSection } from "../overview/overview-surface.js";
import type { DatumBuilderDataElement } from "../data/data-surface.js";
import type { BuilderLanguagesGotoDetail, DatumBuilderLanguagesElement } from "../languages/languages-surface.js";
import type { DatumBuilderPrintElement, PrintWorkspaceSources } from "../print/print-surface.js";
import type { PrintTheme } from "../../render/print/theme.js";
import type { DatumBuilderLogicElement, LogicOpenDocumentDetail } from "../logic/logic-surface.js";
import { showBuilderModal } from "./modal-place.js";

// The builder's `features` list is a pure model; a bundle's element reads it through
// these, and a host can parse a list the way the builder will.
export {
  BUILDER_FEATURES,
  BUILDER_FEATURE_PRESETS,
  builderSides,
  featureOn as builderFeatureOn,
  normalizeBuilderFeatures,
  parseBuilderFeatures,
  warnBuilderFeatureOnce,
  type BuilderFeature,
  type BuilderFeatureSet,
  type BuilderSides
} from "./builder-features.js";

export const DATUM_BUILDER_TAG_NAME = "datum-builder";

export type DatumBuilderComponentType = BuilderComponentType;

export interface DatumBuilderOptions {
  title?: string;
  componentTypes?: DatumBuilderComponentType[];
  initialRoot?: ComponentNode;
  componentDefinitions?: ComponentDefinition[];
  /**
   * The icon set the builder's chrome — the bar, the activity strip, the palette, the drag
   * grips — is drawn from. Unset, the default set: whatever the page registered
   * with `setDefaultIconSet`, else the engine's own drawings. A set's markup is trusted like a
   * theme's CSS; names it leaves out fall back to the engine's drawings.
   */
  icons?: IconSet | undefined;
  /** Locale used to resolve `LocalizedText` labels in the canvas and inspector. Defaults to `"en"`. */
  locale?: string;
  /**
   * The `FormDefinition.localization` of the form being edited — like `initialRoot`, an
   * *initial* value. The properties panel's Form selection edits it; read the authored
   * result back from the `localization` getter (or `controller.localization()`) on each
   * `builder-change` and persist it on the definition beside `root`. The bar's locale
   * switcher offers the locales it declares, under their labels.
   * Removing a language (in Languages) deletes its translations from the definition's
   * `translations` map in the same undo step. A host keeping per-locale data of its own (a
   * translation catalog) does not hear of removals and renames as they happen (Undo would then
   * lose its data): it reads the net change since the form was loaded or last saved when it
   * saves, from `localeChangesSinceSave()` or the `localeChanges` handed to `fileActions.save`,
   * applies it to its catalog, and the builder starts counting again from there.
   */
  localization?: LocalizationConfiguration | undefined;
  /**
   * The `FormDefinition.translations` of the form being edited — an *initial* value
   * like `localization`: the controller holds the map from then on, the Languages workspace edits
   * it, and the host reads the authored result back from `controller.translations()` on each
   * `builder-change` and persists it on the definition beside `root`.
   */
  translations?: FormTranslations | undefined;
  /**
   * The definition's `id`, `version` and `schemaVersion` — like `localization`, an *initial*
   * value the Form selection's Identity section edits; read the authored result back from
   * the `identity` getter on each `builder-change` and persist it on the definition. Leave
   * it out and the builder shows no Identity section: the identity stays the host's.
   */
  identity?: FormIdentity | undefined;
  /**
   * The design-system binding the canvas draws the form with — pass the same one (and the same
   * {@link assets}) the host's form element draws with, and the canvas matches it: a binding,
   * the id of one registered on the page (`registerBinding`), or nothing for Datum's own. A
   * design-system stylesheet that cannot be fetched draws the form element's alert in the
   * canvas's place.
   */
  binding?: LiveBinding | string | undefined;
  /** The design system's files, as the host serves them to its form element. */
  assets?: LiveAssets | undefined;
  /**
   * The bindings the View panel's picker offers (`"datum"` for Datum's own): choosing one draws
   * the canvas with it and emits `builder-binding-change` with its id. Nothing is written into
   * the form or its PDF layouts. With one entry or none there is no picker.
   */
  availableBindings?: BuilderBindingOption[];
  /**
   * Adapters by component type laid over the canvas's binding (`extendBinding`): how a tree of
   * the host's own types draws on the canvas. The designers set theirs on their own controllers.
   */
  canvasComponents?: Readonly<Record<string, AdapterEntry>> | undefined;
  /**
   * Lets the tree fix the sheet's width (see `BuilderControllerOptions.sheetWidth`): called
   * with the previewed root on every repaint, the CSS pixel width it returns sizes the form on
   * the sheet and puts the bar's width picker and the sheet's drag grips away. The PDF designer
   * sets it so the page previews at its paper width.
   */
  sheetWidth?: ((root: ComponentNode) => number | undefined) | undefined;
  /** Resolves `select` options in the canvas preview (see `BuilderControllerOptions`). */
  dataSourceResolver?: DataSourceResolver | undefined;
  /**
   * The host's wiring-time data sources (`defineDataSources`): previewed on the canvas ahead
   * of `dataSourceResolver`, and listed by the inspector's Data source picker.
   */
  dataSources?: DataSourceSet | undefined;
  /** Further source ids for the picker — ones registered on the runtime, which the builder cannot see. */
  dataSourceIds?: string[];
  /**
   * Validation codes the page knows about beyond the engine's own — the keys of its `messages`
   * catalog, the codes its server or sandboxed rules return — offered in the messages editor
   * after the engine's. A bare code, or `{ code, label }` for a hint on hover.
   */
  validationCodes?: HostValidationCode[];
}

export interface DatumBuilderChangeDetail {
  root: ComponentNode;
  selectedComponentId?: string | undefined;
  reason: BuilderChangeReason;
  /**
   * Only on the change that re-seated a component under a new id. The form's own
   * documents follow it in the rename's step of the history (its rules, translations and
   * scenarios, a PDF layout's conditions and sources when the PDF mode is up); a host keeping
   * references of its own outside the form follows them from here.
   */
  renamed?: { from: string; to: string; dataPath?: ValuePathMove };
  /**
   * Only on the change an Undo or a Redo of a rename made: the component answers to `to` again
   * (its old id, after an Undo). The step put back what followed the rename in the form's own
   * documents; a host that followed {@link renamed} in references of its own follows this too.
   */
  renameStepped?: BuilderRenameStepped;
  /**
   * Only on the change of an edit that moved where answers are stored (a data key, a container's
   * key or `scopeData`): each moved value path before and after, to be followed as one
   * map (a path moves once, so two keys swapped stay swapped) by a host reading answers by path.
   * The change an Undo of such an edit made carries each move the other way round (the answers
   * go back), and the change a Redo made carries the same moves again, both with
   * {@link historyStep}. The array is the host's own copy.
   */
  dataMoved?: readonly ValuePathMove[];
  /**
   * On every change an Undo or a Redo made, so a host can tell a redone {@link dataMoved} from a
   * new one: a move map applied twice undoes a swap. An Undo's {@link dataMoved} is the first
   * run's moves reversed, a Redo's is the first run's, so a host following the form applies each
   * change's map as it is told, once. A follower whose rewrite joined the step's own entry (the
   * shell's scenarios, a registered mode) skips these changes: the entry already puts its rewrite
   * back. Absent on every other change.
   */
  historyStep?: "undo" | "redo";
}

/**
 * How `<datum-builder>` lays out its chrome. `"page"` (the default) fills the window below
 * `--db-shell-top` (the height of a host's own app bar, zero by default), for a builder that
 * *is* the page; `"contained"` fills the element's own box, for a builder embedded in a page
 * that has other things on it — the host sizes the element (a height, or a flex/grid cell) and
 * everything, canvas scrolling included, stays within it. Set through the `layout` attribute
 * or property.
 */
export type DatumBuilderLayout = "page" | "contained";

/** The panels the activity strip opens, one at a time, beside the canvas. */
/**
 * The panels the activity strip opens, one at a time, beside the canvas. A host's own panel
 * is any other id: it names it on its `slot="strip"` item and on the `slot="panel"` element
 * that goes with it, and the shell opens the one for the other.
 */
export type DatumBuilderPanel = "form" | "chrome" | "components" | "fields" | "outline" | "variables" | "tests" | "view" | "settings" | (string & {});

/**
 * The builder's workspaces: what the author is doing,
 * one at a time — the Form itself, its Logic, its Data, its Languages, its Journeys, its PDF
 * layouts and how it Prints. A layer over the panels and the modes, not a mode of its own: Form,
 * Logic, Data, Languages and Print edit the form's controller; Journeys and PDF open on their overview with the form
 * still the page's mode, and a card's Open puts that mode's designer on the page.
 */
export type BuilderWorkspace = "form" | "logic" | "data" | "languages" | "journeys" | "pdf" | "print";

/** The workspaces in the bar's order. */
export const BUILDER_WORKSPACES: readonly BuilderWorkspace[] = ["form", "logic", "data", "languages", "journeys", "pdf", "print"];

/** The workspaces of a designer: each one's mode, whose documents its overview lists. */
const DESIGNER_WORKSPACES = { journeys: "journeys", pdf: "pdf" } as const satisfies Partial<Record<BuilderWorkspace, string>>;

/**
 * The leave guard's id for a component the inspector edits on another controller than the mode's
 *: its hold is answered through the inspector's own prompt, never drawn by a surface.
 */
const INSPECTED_LEAVE_GUARD = "inspected-elsewhere";

type DesignerWorkspace = keyof typeof DESIGNER_WORKSPACES;

/** A workspace that edits the form's own controller: every one but a designer's. */
type FormWorkspace = Exclude<BuilderWorkspace, DesignerWorkspace>;

function isDesignerWorkspace(id: BuilderWorkspace): id is DesignerWorkspace {
  return id === "journeys" || id === "pdf";
}

/** The designer workspace a mode belongs to; none for the form, or a host's mode of another kind. */
function workspaceForMode(modeId: string): DesignerWorkspace | undefined {
  return (Object.keys(DESIGNER_WORKSPACES) as DesignerWorkspace[]).find((id) => DESIGNER_WORKSPACES[id] === modeId);
}

export interface BuilderWorkspaceChangeDetail {
  workspace: BuilderWorkspace;
  previous: BuilderWorkspace;
}

function isWorkspace(value: unknown): value is BuilderWorkspace {
  return typeof value === "string" && (BUILDER_WORKSPACES as readonly string[]).includes(value);
}

/**
 * What a host's {@link DatumBuilderElement.translationsSource} answers: the catalog
 * it hands the runtime, so the Languages workspace can say which texts the page overrides. The
 * builder only reads it; the host's catalog is the host's to edit.
 */
export interface TranslationsCatalogSource {
  /** The host's translation catalog: what it currently hands the runtime. */
  catalog: TranslationCatalog;
}

/** A form file the author chose with the bar's Open button: its name and its text. */
export interface BuilderFormFile {
  name: string;
  text: string;
}

/**
 * The bar's file actions: New, Open and Download, each a button on the bar only when the host
 * supplies it (see {@link DatumBuilderElement.fileActions}). The builder does the asking —
 * the unsaved-edits guard, the confirmation, the file picker, the save as a download — and the
 * host does what only it knows: what an empty form is, whether a file is a form, and the whole
 * definition to save.
 */
export interface BuilderFileActions {
  /** Put an empty form in place of this one. */
  new?: () => void;
  /** Check a chosen file; return the step that puts it in place, or throw (reject) with a message to refuse it. */
  open?: (file: BuilderFormFile) => (() => void) | Promise<() => void>;
  /** The form as a file to save. */
  download?: () => { name: string; text: string; type?: string };
  /**
   * Save the form where the host keeps it: the file menu's Save, and Ctrl/Cmd+S in
   * the builder. The builder asks about unapplied edits first, then calls it; while a returned
   * promise is pending the item says so, and a rejection's message shows beside the menu.
   * It is handed the languages changed since the form was loaded or last saved, for a host
   * keeping a translation catalog to apply (see {@link BuilderSaveContext}); once the save
   * succeeds they count from there.
   */
  save?: (context: BuilderSaveContext) => void | Promise<void>;
  /** Save's name in the menu; "Save" unless given (say "Save draft"). */
  saveLabel?: string;
  /**
   * Whether the form as the host holds it has nothing a New would lose — say no PDF layouts
   * or journeys of the author's making — so New may go ahead without asking. Consulted only
   * when the builder's own check (no components, no root settings, no languages) passes;
   * unset, that check decides alone.
   */
  isEmpty?: () => boolean;
}

/** What the builder hands the host's {@link BuilderFileActions.save}. */
export interface BuilderSaveContext {
  /**
   * The net change to the form's languages since it was loaded or last saved: a
   * host keeping per-locale data of its own (a translation catalog) drops what it holds under
   * `removed` and moves what it holds under each `renamed.from` to `to` — then saves. Undo before
   * a save loses nothing, because nothing is announced before it.
   */
  localeChanges: LocaleChanges;
  /**
   * `"agent"` when a browser assistant asked for the save, so a host can log
   * who asked; absent when the person did (the File menu, Ctrl/Cmd+S, the command palette).
   */
  trigger?: "agent";
}

/** The `builder-file-action` event's detail: which file action completed, and the file's name when there is one. */
export interface BuilderFileActionDetail {
  action: "new" | "open" | "download" | "save";
  name?: string;
  /** On `save`, when the languages changed since the form was loaded or last saved: what the save was handed (see {@link BuilderSaveContext}). */
  localeChanges?: LocaleChanges;
  /** On `save`, `"agent"` when a browser assistant asked for it (see {@link BuilderSaveContext.trigger}). */
  trigger?: "agent";
}

/**
 * How a save a browser assistant asked for ended:
 * `saved` (with the languages changed since the last save, when any were); `no-save` when the host
 * lends no Save; `busy` while a save runs; `held` while something the person has not answered is
 * in the way (an unsaved-changes prompt up, a draft on the selection or the form root, an editor
 * outside the tree holding edits), which the agent's path never asks about itself; `failed` with
 * the host's own words when its save threw or rejected.
 */
export type BuilderSaveOutcome =
  | { status: "saved"; localeChanges?: LocaleChanges }
  | { status: "no-save" }
  | { status: "busy" }
  | { status: "held"; reason: "prompt" | "draft" | "leave-guard"; componentId?: string }
  | { status: "failed"; message: string };

/**
 * The canvas's Try it seams as {@link DatumBuilderElement.agentTryParts}
 * hands them to the builder agent's element host: each is the canvas member of the same name,
 * reached on the canvas the shell has at the time of the call (`onTrySubmit` hears the canvas's
 * `builder-try-submit` on the shell, so it outlives a rebuilt canvas).
 *
 * @internal
 */
export type BuilderAgentTryParts = Pick<
  DatumBuilderCanvasElement,
  | "triedRuntime"
  | "agentTryCheck"
  | "agentTrySubmit"
  | "quietTriedPageFocus"
  | "focusedTriedPath"
  | "tryReady"
  | "tryPageIdOf"
  | "tryNodeIdOf"
  | "tryRecording"
  | "tryShowing"
  | "tryServerChecks"
  | "onTrySubmit"
  | "tryChunkState"
>;

/**
 * What the Languages surface draws its rows from beyond the form's controller
 * ({@link DatumBuilderElement.agentLanguageInputs}): the journeys' and the PDF layouts' texts, the
 * host's catalog when it lends one, and the designer sides whose texts the form holds but cannot
 * be listed because their mode is not on the page. The header and footer texts are the
 * controller's own.
 *
 * @internal
 */
export interface BuilderAgentLanguageInputs {
  extraTexts: TranslatableText[];
  pdfTexts: TranslatableText[];
  catalog?: TranslationCatalog;
  notLoaded: Array<"journeys" | "pdf">;
}

/**
 * Widths the bar offers, named for the devices they stand for, so "does this form work on a
 * phone" is one click; any other width is a drag of the sheet's edge away (or a host calling
 * `BuilderController.setPreviewWidth` directly), and shows as the Custom entry.
 *
 * The empty value is the sheet's own default width (see --db-sheet-w), not the width of the
 * canvas — a form is a column on a page, and authoring it edge-to-edge would be authoring
 * against a width nobody fills it in at.
 */
const PREVIEW_WIDTHS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Fit page" },
  { value: "360", label: "Galaxy S24 (360)" },
  { value: "375", label: "iPhone SE (375)" },
  { value: "393", label: "iPhone 16 (393)" },
  { value: "430", label: "iPhone 16 Pro Max (430)" },
  { value: "768", label: "iPad Mini (768)" },
  { value: "834", label: "iPad Air (834)" },
  { value: "1024", label: "iPad Pro (1024)" },
  { value: "1280", label: "Laptop (1280)" },
  { value: "1440", label: "Desktop (1440)" }
];

/** The glyphs the shell repaints in place when its icon set changes (the show-hidden toggle's is painted with its state). */
const SHELL_GLYPHS: ReadonlyArray<DatumIconName> = [
  "undo",
  "redo",
  "preview-width",
  "binding",
  "form-panel",
  "chrome-panel",
  "components-panel",
  "fields-panel",
  "outline-panel",
  "variables-panel",
  "tests-panel",
  "validate",
  "view-panel",
  "settings-panel",
  "document-menu",
  "new-form",
  "open-form",
  "download-form"
];

/** A glyph slot the shell repaints in place when its icon set changes. */
function glyphSlot(icons: IconSet, name: DatumIconName): string {
  return `<span class="glyph" data-glyph="${name}">${renderIcon(icons, name)}</span>`;
}

/**
 * A mode's word for one of its documents (`BuilderDocuments.noun`), lower case — the document's
 * own word first when it has one (`BuilderDocument.noun`); "document" when neither names one.
 */
function documentNoun(mode: BuilderMode, document: BuilderDocument | undefined, words: BuilderWords): string {
  const noun = document?.noun?.trim() || mode.documents?.noun?.trim();
  return noun ? noun : words.text("shell.doc.noun");
}

/**
 * What kind of document the bar's label names: "Form" for the builder's own tree, "PDF layout"
 * for a layout, else the document's word capitalised ("Journey").
 */
function documentKind(mode: BuilderMode, document: BuilderDocument | undefined, words: BuilderWords): string {
  if (mode.id === PRIMARY_BUILDER_MODE) {
    return words.text("shell.workspace.form");
  }
  const noun = documentNoun(mode, document, words);
  return mode.id === "pdf" && noun === "layout" ? words.text("shell.doc.kind.pdfLayout") : capitalized(noun);
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The longest form file Open reads unless the host sets another cap: the 2 MiB the elements hold a definition to. */
const MAX_OPEN_FILE_BYTES = 2 * 1024 * 1024;

/** A chosen file's text. FileReader rather than Blob.text(): the same result, and it also works under a test DOM. */
function readFileText(file: Blob, unreadable: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(unreadable));
    reader.readAsText(file);
  });
}

/** What a refusal says: an Error's (or a DOMException's) message, or the thrown value itself. */
/** The node with this id in a tree, if any. */
function findNodeById(node: ComponentNode, id: string): ComponentNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const children of Object.values(node.children ?? {})) {
    for (const child of children) {
      const found = findNodeById(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : String(error);
}

/**
 * Under this wrap width (px) the side column and the inspector become drawers over the canvas;
 * a wrap with no layout yet (jsdom, a detached element) is never narrow.
 */
const NARROW_MAX = 900;

/**
 * Under this wrap width (px) the shell is a phone: one top row, a bottom bar, every
 * drawer a bottom sheet and a menu drawer for the rest. Inside Narrow, so its rules hold too.
 */
const PHONE_MAX = 768;

/**
 * A phone turned on its side is wider than {@link PHONE_MAX} but still a phone: a viewport
 * shorter than this (px) with a coarse pointer keeps the phone layout.
 */
const PHONE_SHORT_MAX = 500;

/**
 * Under this shell width, or height, the inspector's sheet opens tall:
 * 70% of a 568 px screen leaves the body a sliver. The author's own tap on the handle wins.
 */
const PHONE_SMALL_WIDTH = 360;
const PHONE_SMALL_HEIGHT = 600;

/** The sheet up on a phone: one at a time. */
type PhoneSheet = "menu" | "more" | "results" | "surface" | "side" | "props";

/** The host's bar slots, which a phone moves into its menu drawer (spec 3.6). */
const PHONE_HOST_SLOTS: readonly string[] = ["canvas-actions", "toolbar", "history", "comments", "publish", "account"];

/**
 * One of the shell's own strip panels: its strip item and what the shell does with it. The one
 * table every panel list derives from — the strip's
 * markup, which panels a strip click may open, which ones `persist-panels` puts back and which
 * element each one shows — so a panel is added, moved to a workspace or dropped in one place.
 * A host's own panels are not here: they name themselves through their `data-panel`.
 */
interface ShellPanel {
  id: RememberedPanel;
  /**
   * The item's words live in the builder text catalog: `shell.panel.<id>.label` (its accessible
   * name), `.title` (its tooltip) and, when the label is too long for a phone's bottom bar,
   * `.short` (the word under the item). This flag says the item has a `.short`.
   */
  short?: boolean;
  glyph: DatumIconName;
  /** A data attribute the item carries for the code and tests that find it, without its value. */
  marker?: string;
  /** Put back by `persist-panels` (see savePanels). */
  remembered: boolean;
  /** The workspaces whose strip shows the item. */
  workspaces: readonly BuilderWorkspace[];
}

/** The rail's types, most used first: the ones the form offers, in this order. */
const RAIL_ORDER: readonly string[] = ["text", "textarea", "number", "date", "select", "radio", "checkboxes", "checkbox", "file", "signature", "fieldset", "panel"];
/** How many types the rail shows before All components. */
const RAIL_SIZE = 9;

const SHELL_PANELS: readonly ShellPanel[] = [
  // "Form settings", not "Form": the Form workspace's tab has that name.
  { id: "form", short: true, glyph: "form-panel", marker: "data-form-panel-item", remembered: true, workspaces: ["form", "journeys", "pdf"] },
  { id: "chrome", short: true, glyph: "chrome-panel", marker: "data-chrome-panel-item", remembered: true, workspaces: ["form"] },
  // Form reaches the palette from the rail's All components; a designer, which has no rail, from here.
  { id: "components", short: true, glyph: "components-panel", remembered: true, workspaces: ["journeys", "pdf"] },
  // The form's fields beside a journey's step: offered while the Step view is up (`fieldsOffered`).
  { id: "fields", glyph: "fields-panel", marker: "data-fields-panel-item", remembered: true, workspaces: ["journeys"] },
  { id: "outline", glyph: "outline-panel", remembered: true, workspaces: ["form", "logic", "journeys", "pdf"] },
  { id: "variables", glyph: "variables-panel", marker: "data-variables-panel-item", remembered: true, workspaces: ["logic", "data", "journeys", "pdf", "print"] },
  // The form's scenarios: the same on every workspace, because tests are the form's. Remembered by
  // `persist-panels`; the panel then skips its opening run (see `restored` in adoptLazyPanel).
  { id: "tests", glyph: "tests-panel", marker: "data-tests-panel-item", remembered: true, workspaces: ["form", "logic", "data", "journeys", "pdf", "print"] },
  { id: "view", glyph: "view-panel", remembered: true, workspaces: ["form"] },
  // The builder's own settings: what the author tries the form with, never the form itself.
  { id: "settings", glyph: "settings-panel", marker: "data-settings-panel-item", remembered: true, workspaces: ["form", "logic", "data", "languages", "journeys", "pdf", "print"] }
];

/** Save's glyph in the file menu: a tray with an arrow into it. */
function saveGlyph(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"></path></svg>`;
}

/** Whether the keyboard's command key is ⌘ (the menu names Save's key as the platform does). */
/**
 * The Submit button File > New seeds, as it was placed: id "submit", a button whose
 * configuration is exactly its label and its Submit action, nothing else set on it. The
 * controller's own check of the same shape is private to it.
 */
function isUntouchedSeededSubmit(node: ComponentNode): boolean {
  const { id, type, configuration, children, ...rest } = node;
  const set = Object.entries(configuration ?? {}).filter(([, value]) => value !== undefined);
  const { label, action } = (configuration ?? {}) as { label?: unknown; action?: unknown };
  return (
    id === "submit" &&
    type === "button" &&
    set.length === 2 &&
    label === "Submit" &&
    action === "submit" &&
    Object.values(children ?? {}).every((group) => (group?.length ?? 0) === 0) &&
    Object.values(rest).every((value) => value === undefined)
  );
}

function isApplePlatform(): boolean {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return /Mac|iPhone|iPad/.test(nav?.platform ?? nav?.userAgent ?? "");
}

/** The full-window button's glyph: arrows out to the corners, or back in while full window. */
function fullWindowGlyph(on: boolean): string {
  const path = on ? "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" : "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7";
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;
}

/** The markup keys whose words depend on the `features` list (see textKey); read again as the list changes. */
const FEATURE_WORD_KEYS: ReadonlySet<string> = new Set(["shell.bottom.try", "view.showHidden.label", "view.showHidden.note"]);

/** The panel open when the shell first draws. */
const INITIAL_PANEL: ShellPanel["id"] = "components";

/** The panel a workspace opens on until the author picks another there. */
/** Logic opens with no drawer: its own surface has the rule kinds where the drawer would be. */
const WORKSPACE_DEFAULT_PANEL: Readonly<Record<BuilderWorkspace, DatumBuilderPanel | undefined>> = {
  form: "components",
  logic: undefined,
  // Data opens on its schema table; its import is a dialog the surface owns.
  data: undefined,
  // Languages opens on its own cards: the form's languages and every text.
  languages: undefined,
  // A designer opened from its overview opens with no panel; these apply when one is entered otherwise.
  journeys: "components",
  pdf: "components",
  // Print opens on its own card and sheet.
  print: undefined
};

/** The shell's own panels, the only ones `persist-panels` puts back (see savePanels). */
const REMEMBERED_PANELS: readonly RememberedPanel[] = SHELL_PANELS.flatMap((panel) => (panel.remembered ? [panel.id] : []));

/** The ids a strip click may open besides a host's own panels. */
const STRIP_PANEL_IDS: ReadonlySet<string> = new Set(SHELL_PANELS.map((panel) => panel.id));

/** The strip panels whose body is a chunk of its own. */
type LazyPanelId = "chrome" | "variables" | "tests";

/** How a lazy strip panel's body is fetched: the module once loaded, and the call that loads it. */
interface LazyPanelLoader {
  /** The element's tag, the same one the side column's markup draws. */
  tag: string;
  /** The module when a load has finished (once per page), else `undefined`. */
  loaded(): { define(): void } | undefined;
  /** Fetches the module; the element is defined by the shell, after its host is hidden for the upgrade. */
  load(): Promise<unknown>;
}

const LAZY_PANEL_LOADERS: Readonly<Record<LazyPanelId, LazyPanelLoader>> = {
  chrome: {
    tag: DATUM_BUILDER_CHROME_PANEL_TAG,
    loaded: () => {
      const module = chromePanelLoaded();
      return module ? { define: module.defineBuilderChromePanel } : undefined;
    },
    load: loadChromePanel
  },
  variables: {
    tag: DATUM_BUILDER_VARIABLES_PANEL_TAG,
    loaded: () => {
      const module = variablesPanelLoaded();
      return module ? { define: module.defineBuilderVariablesPanel } : undefined;
    },
    load: loadVariablesPanel
  },
  tests: {
    tag: DATUM_BUILDER_TESTS_PANEL_TAG,
    loaded: () => {
      const module = testsPanelLoaded();
      return module ? { define: module.defineBuilderTestsPanel } : undefined;
    },
    load: loadTestsPanel
  }
};

/**
 * The seam for a features list: the loader behind a strip panel whose body is lazy,
 * `undefined` for a panel drawn with the shell. SHELL_PANELS stays the static list of ids,
 * labels and workspaces; a caller that has turned a panel off skips this load.
 */
function panelLoader(panelId: DatumBuilderPanel | undefined): LazyPanelLoader | undefined {
  return isLazyPanel(panelId) ? LAZY_PANEL_LOADERS[panelId] : undefined;
}

function isLazyPanel(panelId: DatumBuilderPanel | undefined): panelId is LazyPanelId {
  return panelId === "chrome" || panelId === "variables" || panelId === "tests";
}

/** A strip panel's accessible name, from the builder text catalog. */
function panelLabel(panel: ShellPanel, words: BuilderWords): string {
  return words.text(`shell.panel.${panel.id}.label` as BuilderTextKey);
}

/** A strip panel's tooltip, from the catalog. */
function panelTitle(panel: ShellPanel, words: BuilderWords): string {
  return words.text(`shell.panel.${panel.id}.title` as BuilderTextKey);
}

/** The word under a strip item on a phone's bottom bar: its `.short`, else its label. */
function panelShort(panel: ShellPanel, words: BuilderWords): string {
  return panel.short ? words.text(`shell.panel.${panel.id}.short` as BuilderTextKey) : panelLabel(panel, words);
}

/** The strip's own items, in order. */
function stripItems(icons: IconSet, words: BuilderWords): string {
  return SHELL_PANELS.map(
    (panel) => `<button type="button" class="strip-btn" role="tab" data-panel="${panel.id}" aria-selected="${panel.id === INITIAL_PANEL}"
              aria-controls="side" data-tip="${escapeHtml(panelTitle(panel, words))}" data-tip-side="end" aria-label="${escapeHtml(panelLabel(panel, words))}" data-workspaces="${panel.workspaces.join(" ")}"${panel.marker ? ` ${panel.marker}` : ""}>${glyphSlot(icons, panel.glyph)}<span class="strip-label" aria-hidden="true">${escapeHtml(panelShort(panel, words))}</span></button>`
  ).join("\n            ");
}

function wrapperStyles(): string {
  return `
    :host {
      display: block;
      /* Layout (the shell's own, never a theme's): the strip card's width and the inset every card keeps from the edges and each other. */
      --db-strip-w: 52px;
      --db-gap: 12px;
      --db-side-w: 240px;
      --db-props-w: 300px;
      /* The studio tokens (studio-tokens.ts), the same list every panel prints. */
${studioTokenDeclarations()}
      font-family: var(--db-font);
    }
${studioTokenRules()}
    * { box-sizing: border-box; }
    /* A panel with a wider default drawer (PANEL_DRAWER_WIDTHS); the wrap's inline width, once the author drags, outranks it. */
${Object.entries(PANEL_DRAWER_WIDTHS).map(([id, width]) => `    .wrap[data-open-panel="${id}"] { --db-side-w: ${width}px; }`).join("\n")}
    /* A finger has no keyboard to hint at: the shortcut badges go. */
    .wrap[data-pointer="coarse"] .file-item-key { display: none; }
    /*
     * The shell: one bar across the top, and below it a row — the activity strip,
     * the one side panel it opens, the canvas, the properties panel — every column as tall as
     * the shell. Nothing floats and nothing is measured from script: the columns are flex
     * items, the side panels docked, and the sheet keeps its own width inside the canvas
     * column (the form is authored at the width it is filled in at, whatever the furniture
     * around it takes), which scrolls sideways when the column is narrower than the sheet.
     *
     * The page layout pins the whole shell to the window below --db-shell-top, the height of
     * a host's own app bar; the contained layout fills the element's box instead (the host
     * sizes it). Both are the same flex column, so the two differ by one rule each.
     */
    .wrap {
      position: fixed;
      top: var(--db-shell-top, 0px); left: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column;
      overflow: hidden;
      /* The studio backdrop: a flat grey under a dot grid, the cards floating over it. */
      background-color: var(--db-backdrop);
      background-image: radial-gradient(var(--db-backdrop-dot) 1px, transparent 1.4px);
      background-size: 22px 22px;
      color: var(--db-ink);
      /*
       * The size tiers follow the shell's own box, not the window: a contained
       * builder in a short host box is Short whatever the screen. Container queries, never script.
       */
      container: db-shell / size;
    }
    :host([layout="contained"]) {
      position: relative;
      display: block;
      height: 100%;
      min-height: 460px;
      overflow: hidden;
    }
    .wrap[data-layout="contained"] {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }
    /*
     * Full window: the builder over the whole browser window, above the page it is
     * embedded in, whatever its layout. Fixed to the window, so an ancestor that makes itself
     * the containing block (a transform, a filter, contain) keeps it inside that box instead.
     */
    :host([full-window]) {
      position: fixed !important;
      inset: 0;
      z-index: 2147483000;
      height: auto; min-height: 0;
    }
    :host([full-window]) .wrap { top: 0; }

    /*
     * The bar. Three columns: the host's leading controls and undo/redo, the document tabs
     * centred, then the canvas's controls, a mode's own actions and the host's trailing
     * controls. The outer columns share the width equally around the tabs (minmax(0, 1fr)
     * rather than 1fr, so a crowded side wraps inside its own group instead of pushing the
     * tabs off centre), and the tabs take only what they need.
     */
    /*
     * Three columns: the controls either side keep their one-row width (max-content) and the
     * document tabs between them take what is left and scroll, so a form with many layouts
     * never wraps the bar; with room to spare the tabs sit centred. On a narrow shell
     * (data-narrow) the sides give way instead and wrap, with the tabs held to
     * half the bar.
     */
    .bar {
      position: relative; z-index: 4;
      flex: none;
      display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(0, auto) minmax(max-content, 1fr);
      align-items: center; column-gap: var(--db-space-2);
      /* Studio: the bar is a row of pills on the backdrop, not a band of its own. */
      background: transparent;
      padding: var(--db-gap) var(--db-gap) 0;
      /* The bar's tool size, one variable: its buttons and the host's leading controls (slotted, so they inherit it) read it, and the Short and touch tiers set it. */
      --db-bar-tool: 38px;
    }
    .bar-start, .bar-end {
      display: flex; align-items: center; gap: var(--db-space-2); flex-wrap: wrap; min-width: 0;
    }
    /* The leading group (file actions, the host's leading controls, undo and redo) is one pill. */
    .bar-start { justify-self: start; }
    /* A mode's views switch is a pill of the same look, drawn by the shell: .bar-group. */
    .bar-start, .bar-group {
      gap: var(--db-space-half);
      padding: var(--db-space-1);
      background: var(--db-surface);
      border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-pill);
      box-shadow: var(--db-shadow-pill);
    }
    .bar-end { justify-content: flex-end; }
    .bar-group { display: flex; align-items: center; position: relative; min-width: 0; }
    /* Nothing on show in it (the views switch is hidden until a journey is open): no empty pill. */
    .bar-group:not(:has(> :not([hidden]))), .bar-group > [hidden], .bar-seg[hidden] { display: none; }
    /* On a phone the mode's worded actions join it in the menu drawer: the round button grows into a pill around its words. */
    .bar-group .bar-btn { width: auto; min-width: var(--db-bar-tool); padding: 0 var(--db-space-3); gap: var(--db-space-2); font-size: var(--db-text-base); white-space: nowrap; }
    .bar-group .bar-btn[data-builder-primary], .bar-group .bar-btn[data-builder-primary]:hover { background: var(--db-accent); color: var(--db-accent-ink); }
    /* A segmented child (data-segmented): its buttons are the workspace tabs' segments, aria-pressed the selected one. */
    .bar-seg { display: flex; align-items: center; gap: var(--db-space-half); }
    .bar-group .bar-seg .bar-btn { padding: 0 var(--db-space-4); color: var(--db-ink-muted); }
    .bar-group .bar-seg .bar-btn:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    .bar-group .bar-seg .bar-btn[aria-pressed="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    /* The leading column: the leading pill, then the workspaces. */
    .bar-lead { display: flex; align-items: center; gap: var(--db-space-2); flex-wrap: wrap; min-width: 0; justify-self: start; }
    /* The workspaces: a pill of segments, the current one in the selected fill. */
    .workspaces { display: flex; align-items: center; min-width: 0; }
    .workspace-tabs {
      display: flex; align-items: center; gap: var(--db-space-half);
      padding: var(--db-space-1);
      background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-pill); box-shadow: var(--db-shadow-pill);
    }
    .workspace-tab {
      height: 38px; padding: 0 var(--db-space-4); border: 0; border-radius: var(--db-radius-pill);
      background: transparent; color: var(--db-ink-muted); font: inherit; font-size: var(--db-text-base); font-weight: 500; cursor: pointer;
      transition: background var(--db-motion-fast) var(--db-ease);
    }
    .workspace-tab:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    .workspace-tab[aria-selected="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    .workspace-tab[hidden] { display: none; }
    /* A count of problems in the workspace: words in the tab's name, the danger chip on screen. */
    .workspace-count {
      display: inline-grid; place-items: center; min-width: 20px; height: 20px; margin-inline-start: var(--db-space-2); padding: 0 6px;
      border-radius: var(--db-radius-pill); background: var(--db-danger); color: var(--db-surface); font-size: var(--db-text-xs); font-weight: 600;
    }
    /* The Tests item's count: the same danger chip, at the item's top end corner. */
    .strip-btn[data-tests-panel-item] { position: relative; }
    .strip-count {
      position: absolute; inset-block-start: 0; inset-inline-end: 0; display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px;
      border-radius: var(--db-radius-pill); background: var(--db-danger); color: var(--db-surface); font-size: var(--db-text-xs); font-weight: 600; line-height: 1; pointer-events: none;
    }
    .workspace-menu {
      display: none; height: 40px; padding: 0 var(--db-space-3); font: inherit; font-size: var(--db-text-base); font-weight: 500;
      color: var(--db-ink); background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-pill); box-shadow: var(--db-shadow-pill); cursor: pointer;
    }
    /* A strip item another workspace owns, the shell's or a host's. */
    [data-out-of-workspace] { display: none !important; }
    .strip ::slotted([data-out-of-workspace]) { display: none !important; }
    /*
     * Narrow: the sides take what their controls need and the centre the rest, the document's
     * name giving way first. Shared equally, an empty end column took a third of the bar and
     * folded the leading controls onto three rows.
     */
    .wrap[data-narrow] .bar { grid-template-columns: max-content minmax(0, 1fr) max-content; }
    .wrap[data-narrow] .bar-centre { justify-content: flex-start; }
    .bar-sep { width: var(--db-border-w, 1px); height: 22px; background: var(--db-line-divider); margin: 0 var(--db-space-1); }
    .bar-sep[hidden] { display: none; }
    /* An icon button on the bar: undo, redo, the show-hidden toggle, the tab menu, the add button. */
    .bar-btn {
      display: inline-flex; align-items: center; justify-content: center;
      /* Studio: a round, borderless button inside a pill. */
      width: var(--db-bar-tool); height: var(--db-bar-tool); padding: 0;
      border: 0; background: transparent; color: var(--db-ink-muted);
      border-radius: var(--db-radius-pill); font: inherit; font-size: var(--db-text-sm); font-weight: 500; cursor: pointer;
      transition: background var(--db-motion-fast) var(--db-ease);
    }
    .bar-btn:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    /* Nothing to undo, nothing to redo: the button stays where it is, faded rather than gone. */
    .bar-btn:disabled { opacity: .4; cursor: default; }
    .bar-btn:disabled:hover { background: transparent; }
    .bar-btn svg, .glyph svg { width: var(--db-icon-size, 16px); height: var(--db-icon-size, 16px); }
    .bar-btn[aria-pressed="true"], .bar-btn[aria-expanded="true"] {
      background: var(--db-selected); color: var(--db-selected-ink);
    }
    .bar-btn[hidden] { display: none; }
    /* At the shell's edge, the leading pill's tooltips start under their button. */
    .bar-start [data-tip]::after { left: auto; inset-inline-start: 0; transform: none; }
    .bar-end > :last-child[data-tip]::after { left: auto; inset-inline-end: 0; transform: none; }
    /* The way back to an overview is words, not a glyph: as wide as they are, in ink. Not while the form is tried (Back to editing comes first). */
    .bar-btn.bar-back { width: auto; padding: 0 var(--db-space-3); color: var(--db-ink); font-size: var(--db-text-base); white-space: nowrap; }
    .wrap[data-trying] :is(.bar-back, [data-overview-back-sep]) { display: none; }
    /* Keyboard focus in the look's accent, the same ring the host-control sheet gives a host's bar controls. */
    /*
     * The file actions (New, Open, Download) lead the bar when the host supplies them, and a
     * refusal (a file that is not a form) shows beside them until dismissed or until the next
     * action succeeds. Its Dismiss is a bar button with a word on it: the box grows to fit.
     * The message keeps to one line, cut short with an ellipsis, so the bar keeps its height;
     * its title (and the alert, to a screen reader) carries the whole of it.
     */
    .file-actions { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    /* The file menu: the shared menu, dropping from the three-dot button's end edge as the document menu does from its start. */
    .file-menu, .document-menu { position: absolute; top: calc(100% + 4px); }
    .file-menu { inset-inline-end: 0; min-width: 200px; }
    .file-item[hidden], .file-sep[hidden] { display: none; }
    .file-item { white-space: nowrap; }
    .file-item .glyph { display: inline-flex; color: var(--db-ink-muted); }
    /* The Dark mode item carries a moon and a sun and shows one: the class's display must not beat the attribute. */
    .file-item .glyph[hidden] { display: none; }
    .file-item-label { flex: 1; }
    .file-item-key { font: inherit; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
    .file-item-key:empty { display: none; }
    .file-item:disabled, .file-item[aria-disabled="true"] { opacity: .6; cursor: progress; }
    .file-sep { height: var(--db-border-w); margin: 4px 6px; background: var(--db-line-divider); }
    .file-actions[hidden] { display: none; }
    /* Studio: a danger pill inside the leading pill — the error wash, its line, its ink. */
    .file-error {
      display: inline-flex; align-items: center; gap: var(--db-space-2); min-width: 0; max-width: 36em;
      min-height: 32px; padding-block: var(--db-space-half); padding-inline: var(--db-space-3) var(--db-space-half);
      border: var(--db-border-w) solid var(--db-danger-line);
      border-radius: var(--db-radius-pill);
      color: var(--db-danger);
      background: var(--db-danger-soft);
      font-size: var(--db-text-sm); font-weight: 500; line-height: 1.3;
    }
    .file-error[hidden] { display: none; }
    .file-error-message { min-width: 0; max-width: 42ch; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .bar-btn.file-error-dismiss {
      flex: none; width: auto; height: 28px;
      padding: 0 var(--db-space-3);
      color: var(--db-danger); font-size: var(--db-text-sm); font-weight: 600;
    }
    .bar-btn.file-error-dismiss:hover { background: var(--db-surface); color: var(--db-danger); }
    /* The base rules every panel prints: the focus ring and the drawn dropdown, for the View and Settings panels' own fields. */
${FOCUS_AND_SELECT_STYLES}
    /* The file actions' confirmation: the look of the panels' unsaved-changes prompt. */
${CONFIRM_STYLES}
    /* The shared patterns (builder-shared.ts), for the shell's own panels and the modes' overlays. */
${SHARED_PATTERN_STYLES}
${ICON_BUTTON_STYLES}
${TIP_STYLES}
    /* A glyph slot is never the hit target — the click belongs to the control around it. */
    .glyph { display: inline-flex; align-items: center; pointer-events: none; }
    .glyph svg { pointer-events: none; }
    /*
     * The locale switcher, in the Settings panel: its own element, whose native
     * select is exposed as part "select", drawn as the panel's other selects. A rule here
     * outranks the element's own (the outer tree wins), so it keeps a plain look elsewhere.
     */
    [data-locale-select] { display: flex; flex-direction: column; gap: var(--db-space-1); }
    /* With show-label the visible words name the select (the element draws a real label). */
    [data-locale-select]::part(label) { font-size: var(--db-text-md); font-weight: 500; }
    [data-locale-select]::part(select) {
      box-sizing: border-box; width: 100%; min-height: var(--db-control-h);
      margin: 0; padding: 0 var(--db-space-3);
      border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
      background-color: var(--db-surface); color: var(--db-ink);
      font: inherit; font-family: var(--db-font); font-size: var(--db-text-base);
      cursor: pointer;
      /* The builder's drawn arrow (FOCUS_AND_SELECT_STYLES), restated: that rule cannot reach into the element's own root. */
      -webkit-appearance: none; appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
      background-repeat: no-repeat; background-size: 5px 5px, 5px 5px;
      background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
      padding-inline-end: 32px; text-overflow: ellipsis;
    }
    [data-locale-select]:dir(rtl)::part(select) { background-position: 12px 50%, 17px 50%; }
    @media (forced-colors: active) {
      [data-locale-select]::part(select) { -webkit-appearance: auto; appearance: auto; background-image: none; }
    }
    [data-locale-select]::part(select):focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }

    /*
     * The document on the page: its name and what kind of
     * document it is, the form, a journey or a PDF layout (the language menu is in Settings).
     * Switching between documents and adding one happen on the Journeys and PDF overviews; a document with
     * options of its own (a journey, a layout: rename, duplicate, order, default, delete) makes
     * the label the button that opens them.
     */
    .bar-centre { display: flex; align-items: center; justify-content: center; gap: var(--db-space-2); min-width: 0; }
    .documents {
      position: relative;
      display: flex; align-items: center;
      max-width: 100%; min-width: min(10rem, 100%);
      padding: var(--db-space-1);
      background: var(--db-surface);
      border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-pill);
      box-shadow: var(--db-shadow-pill);
    }
    .documents[hidden], .document-picker[hidden] { display: none; }
    .document-picker { position: relative; display: flex; min-width: 0; }
    .document-face {
      display: inline-flex; align-items: center; gap: var(--db-space-2); min-width: 0; max-width: 360px;
      height: 38px; border: 0; border-radius: var(--db-radius-pill);
      padding-block: 0; padding-inline: var(--db-space-4) var(--db-space-3);
      font: inherit; font-size: var(--db-text-base); line-height: 1.3;
      color: var(--db-ink); background: transparent; white-space: nowrap;
      /* Held inside the pill: when the centre column is short the chips and name give way, never spill under the actions pill beside it. */
      overflow: hidden;
    }
    button.document-face { cursor: pointer; }
    button.document-face:hover { background: var(--db-surface-hover); }
    button.document-face[aria-expanded="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    .document-face[aria-busy="true"] { opacity: .6; cursor: progress; }
    .document-face-name { min-width: 6ch; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    /* What kind of document it is, and a word its mode puts beside it (Default, Conditional): small pills. */
    /* A chip too long for the room is cut with an ellipsis, never clipped bare; its title carries the whole word. */
    .document-face-type, .document-face-badge {
      flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill);
      background: var(--db-surface-sunken); color: var(--db-ink-muted);
      font-size: var(--db-text-xs); font-weight: 500; line-height: 20px;
    }
    .document-face-badge { background: var(--db-accent-soft); color: var(--db-accent-text); }
    /* Tight (under about 1100px of the shell, data-bar-tight): the chips give way so the name stays legible. */
    .wrap[data-bar-tight] :is(.document-face-type, .document-face-badge) { display: none; }
    button.document-face[aria-expanded="true"] :is(.document-face-type, .document-face-badge) {
      background: color-mix(in oklab, var(--db-selected-ink) 22%, transparent); color: var(--db-selected-ink);
    }
    /* The caret is drawn, so the label's text stays the document's name and kind. */
    button.document-face::after {
      content: ""; flex: none; width: 6px; height: 6px; margin-block-end: 3px;
      border-block-end: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor;
      transform: rotate(45deg); opacity: .7;
    }
    /* A document being renamed: the label gives way to a box the same size. */
    .document-rename {
      width: 160px; height: 34px; border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-pill);
      padding: 0 var(--db-space-3); font: inherit; font-size: var(--db-text-base); font-weight: 600; color: var(--db-ink); background: var(--db-surface);
    }
    /* The document's menu (the shared menu): rename, duplicate, order, default, delete — for the document on the page. Under its caret, at the pill's end: the way back leads the pill. */
    .document-menu { inset-inline-end: 0; }
    .document-menu button[data-document-action="remove"] { color: var(--db-danger); }
    .document-menu > .note { min-inline-size: 260px; }

    /*
     * The row under the bar. The strip is a column of icons, one per panel; the side column
     * holds whichever panel is open (or nothing: the strip with no tab selected collapses it)
     * as a drawer over the canvas, and so does the properties panel on the right,
     * or its stub once folded; the canvas takes the whole width beside the strip and never
     * moves for either.
     */
    .body {
      flex: 1 1 auto; min-height: 0;
      display: flex; align-items: stretch;
      /* The side column is placed over the canvas from here (see .side). */
      position: relative;
    }
    /*
     * Studio: the component rail and the strip are cards floating at the start edge, one over
     * the other, each as tall as its items; the column scrolls them when the shell is short.
     * It reaches 320px past them (its margin gives that back, the pointer passes through) over the drawer, for their tooltips.
     */
    .rails {
      flex: none; width: calc(var(--db-strip-w) + 328px); align-self: flex-start; min-height: 0;
      max-height: calc(100% - 2 * var(--db-gap) + 16px);
      margin-block: calc(var(--db-gap) - 8px) 0; margin-inline: calc(var(--db-gap) - 8px) -320px; padding-block: 8px; padding-inline: 8px 320px;
      display: flex; flex-direction: column; gap: var(--db-space-2);
      position: relative; z-index: 3; overflow-y: auto; scrollbar-width: none; pointer-events: none;
    }
    .rails > * { pointer-events: auto; }
    .add-rail[hidden] { display: none; }
    /* An overview opens no panel and adds nothing: the rails step aside and it takes the width. */
    .wrap[data-overview] .rails { display: none; }
    .strip, .add-rail {
      flex: none; width: 100%;
      display: flex; flex-direction: column; align-items: center; gap: var(--db-space-half);
      padding: 6px 0;
      background: var(--db-surface);
      border: var(--db-border-w) solid var(--db-line-card);
      border-radius: calc(var(--db-strip-w) / 2);
      box-shadow: var(--db-shadow-card);
    }
    .strip-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; padding: 0; flex: none;
      border: 0; border-radius: var(--db-radius-pill);
      background: transparent; color: var(--db-ink-muted); cursor: pointer;
      transition: background var(--db-motion-fast) var(--db-ease);
    }
    .strip-btn:hover { background: var(--db-surface-hover); color: var(--db-ink); }
    .strip-btn[aria-selected="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    .strip-btn[hidden] { display: none; }
    .strip-btn svg { width: var(--db-icon-size, 16px); height: var(--db-icon-size, 16px); pointer-events: none; }
    /* A type on the rail drags as a palette row does: the hand says so before the first try. */
    .rail-btn[data-rail-add] { cursor: grab; }
    .rail-btn[data-rail-add]:active { cursor: grabbing; }
    .rail-more { background: var(--db-surface-sunken); }
    .rail-more[aria-pressed="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
    .rail-btn .palette-icon { width: var(--db-icon-size, 16px); height: var(--db-icon-size, 16px); pointer-events: none; }
    .rail-btn .palette-icon--text { width: auto; height: auto; font-size: var(--db-text-sm); }
    /* The strip's tab list, inside its card. */
    .strip-tabs { display: flex; flex-direction: column; align-items: center; gap: var(--db-space-half); }
    /*
     * The unsaved cue: a pill among the bar's end items, drawn by the shell from saveState.
     * A dot and its words in the warn ink, so the state is a word and a mark, not a hue alone:
     * a dot by itself said nothing until its tooltip was found.
     */
    .save-cue {
      display: inline-flex; align-items: center; gap: var(--db-space-2); flex: none;
      min-height: 28px; padding: 0 var(--db-space-3);
      background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-pill);
      color: var(--db-warn); font-size: var(--db-text-sm); font-weight: 500; white-space: nowrap; cursor: default;
    }
    .save-cue[hidden] { display: none; }
    .save-cue-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    /* A host's own strip items sit with the launchers: the strip sizes them, and the builder's host-control sheet (BUILDER_HOST_CONTROL_STYLES) dresses them like .strip-btn unless a class of the host's does. */
    .strip ::slotted(*) { flex: none; }

    /*
     * The View panel: the canvas controls — how wide the sheet is previewed, which theme it
     * renders in, whether components a rule is hiding are shown. In the side column they can say what
     * they are, which icons with tooltips on the bar could not.
     *
     * It is the shell's own markup rather than an element of its own, so it takes the panel
     * box from the same constant the panel elements put in their shadow roots — without it
     * the column would show the canvas through where the panel should be.
     */
${PANEL_BOX_STYLES}
    /*
     * Studio: a card for the title, then a card per group of settings, each a label over a
     * white 40px box. Every setting here applies at once, so the panel has no Apply.
     */
    .view-row { display: flex; flex-direction: column; gap: var(--db-space-2); }
    .view-row[hidden] { display: none; }
    .view-label { font-size: var(--db-text-md); font-weight: 500; color: var(--db-ink); }
    .view-group, .settings-section { margin: 0; display: grid; gap: var(--db-space-2); }
    /* A section a left-out feature owns (Submitting in Try it) is not drawn: the display above would beat the attribute. */
    .view-group[hidden], .settings-section[hidden] { display: none; }
    .view-group > legend { padding: 0; float: left; width: 100%; }
    .view-check { display: flex; align-items: center; gap: var(--db-space-2); min-block-size: 28px; font-size: var(--db-text-md); color: var(--db-ink); cursor: pointer; }
    .view-check input { margin: 0; inline-size: 24px; block-size: 24px; flex: none; accent-color: var(--db-selected); }
    .source-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); }
    .source-item { border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-md); padding: var(--db-space-2) var(--db-space-3); display: grid; gap: var(--db-space-2); }
    .source-head { display: flex; align-items: center; gap: var(--db-space-2); min-width: 0; }
    .source-id { font-family: var(--db-font-mono); font-size: var(--db-text-sm); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .source-state { flex: none; margin-inline-start: auto; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); color: var(--db-ink-muted); font-size: var(--db-text-xs); font-weight: 500; line-height: 20px; }
    .source-state[data-state="simulated"] { background: var(--db-accent-soft); color: var(--db-accent-text); }
    .source-state[data-state="missing"] { background: var(--db-warn-soft); color: var(--db-warn); }
    .source-item textarea, .settings-section textarea {
      width: 100%; min-block-size: 96px; resize: vertical; box-sizing: border-box; padding: var(--db-space-2);
      border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
      background: var(--db-surface); color: var(--db-ink); font-family: var(--db-font-mono); font-size: var(--db-text-sm);
    }
    .source-actions { display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
    .source-error { margin: 0; font-size: var(--db-text-sm); color: var(--db-danger); }
    .view-row :is(select, input) {
      width: 100%; min-height: var(--db-control-h);
      border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md);
      background-color: var(--db-surface); color: var(--db-ink); padding: 0 var(--db-space-3);
      font: inherit; font-size: var(--db-text-base);
    }
    .view-set { border: 0; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); min-width: 0; }
    .view-set > legend { padding: 0; margin-bottom: var(--db-space-2); }
    .view-note { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); font-variant-numeric: tabular-nums; }
    .view-note[hidden] { display: none; }
    /*
     * The side column is a drawer over the canvas at every width: a panel opens,
     * widens and closes without the form moving under it. Absolute inside the body, beside
     * the strip, at the remembered width — capped so a slice of canvas always shows — drawn
     * on the surface with a divider and a shadow, under the bar's own popovers (z-index 3).
     * The canvas takes the whole width beside the strip; what the drawer covers, it covers.
     */
    /* Studio: an inset card beside the strip, the gap kept on every side (constant insets, no script geometry). */
    .side {
      position: absolute; top: var(--db-gap); bottom: var(--db-gap); left: calc(var(--db-strip-w) + 2 * var(--db-gap)); z-index: 2;
      width: min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)); min-width: 0;
      display: flex; flex-direction: column;
      padding: 0;
      background: var(--db-surface);
      border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-xl);
      box-shadow: var(--db-shadow-overlay);
      overflow: hidden;
    }
    /* Its grip rides the drawer's edge, straddling it as the inspector's straddles its column. */
    .resizer[data-resizer="side"] {
      position: absolute; top: var(--db-gap); bottom: var(--db-gap); margin: 0;
      left: calc(var(--db-strip-w) + 2 * var(--db-gap) + min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)) - 4px);
    }
    .wrap[data-side-collapsed] .side,
    .wrap[data-side-collapsed] .resizer[data-resizer="side"] { display: none; }
    /*
     * A floating panel (the Form panel, Header & footer) draws its own cards, as the
     * inspector does: the drawer is only their place, and the canvas takes the pointer under them.
     * A host's slotted panel is out of :has()'s reach, so the shell marks the drawer for it.
     */
    .side:is(:has(> [data-floating]:not([hidden])), [data-host-floating]) { background: transparent; border: none; border-radius: 0; box-shadow: none; overflow: visible; pointer-events: none; }
    .side > * { flex: 1 1 auto; min-height: 0; display: block; }
    .side > [hidden] { display: none; }
    /*
     * A host's panels come through a slot, which must not be a column of its own: display
     * contents lets each slotted panel be the flex item instead, sized like the shell's own.
     */
    .side > slot[name="panel"] { display: contents; }
    .side ::slotted([slot="panel"]) { flex: 1 1 auto; min-width: 0; min-height: 0; display: block; }
    /* A wrapper's forwarded slot (datum-form-builder) stays out of the layout: its panels are the items. */
    .side ::slotted(slot[slot="panel"]) { display: contents; }
    .side ::slotted([slot="panel"][hidden]) { display: none; }
    /*
     * Logic draws its surface where the canvas is, with its own editor in the inspector's place
     *: the canvas and the inspector drawer step aside while it is on.
     */
    .logic-host { flex: 1 1 auto; min-width: 0; min-height: 0; display: block; position: relative; isolation: isolate; }
    .logic-host[hidden] { display: none; }
    .wrap:is([data-workspace="logic"], [data-workspace="data"], [data-workspace="languages"], [data-workspace="print"], [data-overview]) datum-builder-canvas,
    .wrap:is([data-workspace="logic"], [data-workspace="data"], [data-workspace="languages"], [data-workspace="print"], [data-overview]) .body > datum-builder-properties,
    .wrap:is([data-workspace="logic"], [data-workspace="data"], [data-workspace="languages"], [data-workspace="print"], [data-overview]) .resizer[data-resizer="props"] { display: none; }
    .logic-state {
      margin: var(--db-gap); padding: var(--db-space-6); max-width: 520px;
      background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xl);
      box-shadow: var(--db-shadow-card); display: grid; gap: var(--db-space-3); justify-items: start; pointer-events: auto;
    }
    .logic-state p { margin: 0; }
    datum-builder-canvas {
      flex: 1 1 auto; min-width: 0; min-height: 0; display: block;
      /*
       * Its own stacking context: the canvas layers its sheet grips, outlines and badges with
       * z-indexes of their own, and the drawer over it and the drawer's grip must
       * sit above all of them without out-numbering each one.
       */
      isolation: isolate;
    }
    /*
     * Inside the canvas, --db-side-w is how far the side drawer reaches over the canvas's
     * start edge: its width while open, nothing while folded. The canvas's content stays where
     * it is (what the drawer covers, it covers); only controls pinned to that edge read it, so
     * the drawer never hides them: the journey map's head and foot.
     */
    .wrap[data-side-collapsed] datum-builder-canvas { --db-side-w: 0px; }
    /* And --db-props-w how far the inspector reaches over its end edge: nothing while it is folded or has nothing to show. */
    .wrap[data-props-collapsed] datum-builder-canvas,
    .wrap[data-no-selection] datum-builder-canvas { --db-props-w: 0px; }
    /* Folded with a selection it is still its stub, one button wide: the canvas's bars keep clear of it. */
    .wrap[data-props-collapsed]:not([data-no-selection]) datum-builder-canvas { --db-props-w: 52px; }
    /*
     * The inspector is a drawer over the canvas too, on the right, at its
     * remembered width capped like the side column's. Scoped to .body: the Form panel is the
     * same element in .side, which sizes its own.
     */
    .body > datum-builder-properties {
      position: absolute; top: var(--db-gap); bottom: var(--db-gap); right: var(--db-gap); z-index: 2;
      width: min(var(--db-props-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)); min-width: 0;
      display: block;
      padding: 0;
      background: var(--db-surface);
      border: var(--db-border-w) solid var(--db-line-card);
      border-radius: var(--db-radius-xl);
      box-shadow: var(--db-shadow-overlay);
      overflow: hidden;
    }
    /* Above the drawer it straddles, which follows it in the markup; the bar (z-index 3, its own context) still wins. */
    .resizer[data-resizer="props"] {
      position: absolute; top: var(--db-gap); bottom: var(--db-gap); margin: 0; z-index: 3;
      right: calc(var(--db-gap) + min(var(--db-props-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)) - 4px);
    }
    /*
     * Floating (data-floating): the panel draws its parts as cards of their
     * own, so the drawer is only their place, with no frame, fill or clip of its own. The grip
     * keeps its place on the drawer's edge, its hairline shown only while it is hovered or held:
     * drawn the drawer's height, it would cross the canvas under a short column.
     */
    .body > datum-builder-properties[data-floating] {
      background: transparent; border: none; border-radius: 0; box-shadow: none; overflow: visible;
    }
    .resizer[data-resizer="props"]:not(:hover)::before { background: transparent; }
    .wrap[data-resizing] .resizer[data-resizer="props"]::before { background: var(--db-accent); }
    /* Folded, it is its stub: a rail of one button at the canvas's edge, with no drawer dressing. */
    .wrap[data-props-collapsed] .body > datum-builder-properties {
      width: auto; background: transparent; border: none; box-shadow: none;
    }
    .wrap[data-props-collapsed] .resizer[data-resizer="props"] { display: none; }
    /*
     * Nothing selected: the inspector has nothing to inspect, so its column and
     * its grip go and the canvas takes the width. Form-level settings live on the strip.
     */
    .wrap[data-no-selection] .body > datum-builder-properties,
    .wrap[data-no-selection] .resizer[data-resizer="props"],
    .wrap[data-trying] .body > datum-builder-properties,
    .wrap[data-trying] .resizer[data-resizer="props"] { display: none; }
    ::slotted(*), .slot { min-width: 0; }

    /*
     * Resize grips on the side panels' inner edges: a strip straddling the column boundary.
     * It draws a hairline of its own so the boundary reads as something you can take hold of
     * — invisible until hovered, it would be a control nobody finds, and a panel whose width
     * cannot be changed is a panel that has to hold everything at 240px.
     */
    .resizer {
      flex: none; width: 8px; margin: 0 -4px; z-index: 2;
      cursor: col-resize; background: transparent;
      display: flex; align-items: center; justify-content: center;
    }
    .resizer::before {
      content: ""; width: var(--db-border-w, 1px); height: 100%;
      background: var(--db-line-divider); transition: background var(--db-motion-fast) var(--db-ease), width var(--db-motion-fast) var(--db-ease);
    }
    .resizer:hover::before, .wrap[data-resizing] .resizer::before { width: 3px; background: var(--db-accent); }
    .wrap[data-resizing] { cursor: col-resize; user-select: none; }

    /*
     * Narrow: under 900px one drawer is up at a time (the shell folds the other),
     * the bar wraps, and the grips go, since there is no room to spend. Both columns are
     * drawers at every width, so nothing else is left to this rule.
     */
    .wrap[data-narrow] .resizer { display: none; }
    /*
     * A strip drawer open beside Logic, Data or Languages: the surface keeps clear of it, on
     * its left by the drawer's own width and gap, so no heading or row sits under it. Narrow
     * drawers are sheets over the surface, so they reserve nothing.
     */
    .wrap[data-drawer-open]:not([data-narrow]):is([data-workspace="logic"], [data-workspace="data"], [data-workspace="languages"], [data-workspace="print"]) .logic-host {
      margin-left: calc(2 * var(--db-gap) + min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)));
    }
    /*
     * Recording a test: the Tests drawer stays open beside Try it, and the tried form
     * keeps clear of it the same way, so the fields being answered are never under the drawer.
     * The canvas is then not covered at its start edge, so its pinned controls read no drawer;
     * the room is worked out on the wrap, where the drawer's width is still its own.
     */
    .wrap[data-trying][data-tests-recording][data-drawer-open]:not([data-narrow]) {
      --shell-recording-room: calc(2 * var(--db-gap) + min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)));
    }
    .wrap[data-trying][data-tests-recording][data-drawer-open]:not([data-narrow]) datum-builder-canvas {
      margin-left: var(--shell-recording-room);
      --db-side-w: 0px;
    }
    /*
     * The Journeys workspace's Step view: the step is filled from the drawer beside it (the
     * palette, Form fields) and worded in the inspector, so the canvas keeps clear of both, by
     * each drawer's reach (capped as the drawers are) and a gap, and the sheet centres in the room
     * left, narrower when it must be, as the tried form does beside Try it. Unlike the Form
     * workspace, the step moves when a drawer opens. The room is worked out on the
     * body, where the drawers' widths and the size tier's gap are their own; the canvas then has
     * no drawer over it, so its pinned controls read none. The map and the empty state (surfaces),
     * Try it, the narrow tier and the phone keep the shell's rule.
     */
    .wrap[data-workspace="journeys"]:not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) .body {
      --shell-step-start: 0px;
      --shell-step-end: calc(min(var(--db-props-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)) + var(--db-gap));
    }
    .wrap[data-workspace="journeys"][data-drawer-open]:not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) .body {
      --shell-step-start: calc(min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)) + var(--db-gap));
    }
    .wrap[data-workspace="journeys"][data-no-selection]:not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) .body { --shell-step-end: 0px; }
    .wrap[data-workspace="journeys"][data-props-collapsed]:not([data-no-selection]):not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) .body {
      --shell-step-end: calc(52px + var(--db-gap));
    }
    .wrap[data-workspace="journeys"]:not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) datum-builder-canvas {
      margin-inline: var(--shell-step-start, 0px) var(--shell-step-end, 0px);
      --db-side-w: 0px;
      --db-props-w: 0px;
    }
    /* The size tiers: last, so they override the rules above at equal weight. */
    /*
     * Short (under 720px of shell, e.g. a 640px demo box or a laptop's admin page): compact
     * density. Tighter insets, 34px controls (inherited by every panel through
     * --db-density-control-h), a slimmer strip.
     */
    @container db-shell (max-height: 719px) {
      .bar, .body { --db-gap: 8px; --db-density-control-h: 34px; --db-strip-w: 46px; }
      .bar { --db-bar-tool: 32px; }
      .document-face { height: 32px; }
      .strip-btn { width: 34px; height: 34px; }
      .strip, .add-rail { padding: 4px 0; }
      /* Short: the rail keeps its first five types; All components has the rest. */
      .add-rail [data-rail-rank]:not([data-rail-rank="0"], [data-rail-rank="1"], [data-rail-rank="2"], [data-rail-rank="3"], [data-rail-rank="4"]) { display: none; }
      .workspace-tab { height: 32px; padding: 0 var(--db-space-3); }
      .workspace-menu { height: 34px; }
    }
    /* Narrow (under 1024px of shell): the workspaces become a menu. */
    @container db-shell (max-width: 1023px) {
      .workspace-tabs { display: none; }
      .workspace-menu { display: block; }
    }
    /* A coarse pointer (finger, pen) gets 44px targets everywhere (WCAG 2.5.5). */
    @media (pointer: coarse) {
      .bar, .body { --db-density-control-h: 44px; }
      .bar { --db-bar-tool: 44px; }
      .strip-btn { width: 44px; height: 44px; }
      .workspace-tab { height: 44px; }
      .document-face { height: 44px; }
    }
    /* The phone tier: last of all, over every tier above. */
${PHONE_SHELL_STYLES}
  `;
}

/**
 * The builder shell: one bar, an activity strip that opens one panel at a time
 * (the component palette, the outline), the canvas, and the properties panel docked beside
 * it. Its API: `.options`, `.value`, `builder-change` / `builder-mutation` events,
 * `undo()` / `redo()`. `.controller` exposes the shared {@link BuilderController} for
 * advanced hosts that want to lay the panels out themselves.
 *
 * The bar leads with the file actions — New, Open, Download — when the host supplies them
 * ({@link fileActions}). Three named slots take host controls, all on the bar: `toolbar-start`
 * follows the file actions (a save button), `toolbar` trails the row (a theme picker), and
 * `canvas-actions` — kept from when the canvas had a toolbar of its own — lands at the end
 * beside `toolbar`. A button or select slotted there, and a launcher slotted into `strip`,
 * takes the builder's own look (see `BUILDER_HOST_CONTROL_STYLES`) unless a class of the
 * host's styles it.
 *
 * Modes: a host may register further things for the same
 * shell to edit — the form's PDF layouts — each with a controller of its own; the bar then
 * shows a tab per mode, or per document of a mode that has several. `value`, `options`,
 * `controller` and the `builder-change` event stay the form's; a mode reports its own changes
 * its own way.
 */
export class DatumBuilderElement extends HTMLElementBase {
  private readonly rootNode: ShadowRoot;
  private readonly ctrl = new BuilderController();
  private optionsState: DatumBuilderOptions = {};
  private themeState: BuilderThemeDefinition | undefined;
  private appliedThemeVars: string[] = [];
  /** Where the host's translation catalog comes from (see {@link translationsSource}). */
  private translationsSourceValue: (() => TranslationsCatalogSource) | undefined;
  /** The host's file actions (see {@link fileActions}); a bar button shows for each one supplied. */
  private fileActionsValue: BuilderFileActions | undefined;
  /** The longest file Open reads (see {@link maxDefinitionBytes}). */
  private maxDefinitionBytesValue = MAX_OPEN_FILE_BYTES;
  /** What the file actions' confirmation runs on its OK, while it is up. */
  private fileConfirmRun: (() => void) | undefined;
  /** The file button whose action the confirmation is asking about, which focus goes back to. */
  private fileConfirmOpener: HTMLElement | undefined;
  /** The file button the bar's message is about (Open for a refused file, Download when downloads are unavailable), which Dismiss hands focus back to. */
  private fileErrorSource: string | undefined;

  private toolbarEl!: DatumBuilderToolbarElement;
  private outlineEl!: DatumBuilderOutlineElement;
  private fieldsEl!: DatumBuilderFormFieldsElement;
  /** The Form fields source the panel was last pointed at (the mode's `formFields`) and the way its notices are heard. */
  private fieldsSource: BuilderModeFormFields | undefined;
  private fieldsOff: (() => void) | undefined;
  private canvasEl!: DatumBuilderCanvasElement;
  private serverChecksValue: TryItServerChecksSource | undefined;
  private tryPdfValue: TryItPdfSource | undefined;
  private propertiesEl!: DatumBuilderPropertiesElement;
  /** The strip's Form panel: the inspector, fixed to the controller's root. */
  private formSettingsEl!: DatumBuilderFormPanelElement;
  /**
   * The Header & footer panel: the form root's chrome, in the side column. Set once
   * its chunk has loaded and the element in the side column is upgraded and fed;
   * until then {@link chromePanelHost} is the bare element in the markup, which only ever gets
   * attributes and inline style (hidden, the phone flags, the theme's tokens), never a property.
   */
  private chromePanelEl: DatumBuilderChromePanelElement | undefined;
  private chromePanelHost: HTMLElement | undefined;
  /**
   * The Variables panel: what a rule or a PDF text may reference. Pointed at the
   * form's own controller on every tab — the references are the form's fields whichever
   * document is being edited — and told which syntax to list by the mode on the page. Lazy
   * like the Header & footer panel: {@link variablesPanelHost} until it is loaded.
   */
  private variablesPanelEl: DatumBuilderVariablesPanelElement | undefined;
  private variablesPanelHost: HTMLElement | undefined;
  /**
   * The Tests panel: the form's scenarios, run on the browser's runtime. Pointed at the
   * form's own controller on every tab, since tests are the form's whichever document is being
   * edited. Lazy like the Variables panel: {@link testsPanelHost} until its chunk is loaded.
   */
  private testsPanelEl: DatumBuilderTestsPanelElement | undefined;
  private testsPanelHost: HTMLElement | undefined;
  /** How many tests the panel last reported failing, erroring or unparsed: the count on the strip item. */
  private testsFailing = 0;
  /** The rename follow in flight, so a second rename waits for the first and each sees the tests as the last left them. */
  private testsRenameChain: Promise<void> = Promise.resolve();
  /** Moved by every form the controller loads, so a rename follow that waited for the chunk knows its form is still the one. */
  private testsGeneration = 0;
  /**
   * The scenarios' follow-ups the controller dropped because their step was undone before they
   * landed, each by the step's key ({@link followInStep}): a Redo of that step runs it again,
   * while the step can still be redone.
   */
  private droppedFollows: Array<{ key: { from: string; to: string }; again: () => void }> = [];
  /** The component whose rule the Tests panel asked Logic to open, until the surface is there to open it. */
  private pendingRuleOpen: string | undefined;
  /** The rule key (`visibleWhen`, ...) the Tests panel named with it, so the surface opens that rule. */
  private pendingRuleKind: string | undefined;
  /** Set when `persist-panels` put the Tests panel back open: its first wiring says so, and the panel skips its opening run. */
  private testsRestored = false;
  /**
   * The Logic surface's "Pinned by" source, memoised by the controller change
   * it was built at and the tests block it read, so a repaint or a second connect costs nothing.
   */
  private testsPinsStamp = 0;
  private testsPinsMemo: { stamp: number; key: string; source: TestsPinsOf } | undefined;
  /** Moved by every request for pins, so an answer that lands after a newer request is dropped. */
  private testsPinsRequest = 0;
  /** Set while Try it takes the side column away, so that is not the Tests panel being closed (a showing ends on a close, not on that). */
  private enteringTry = false;
  /** A lazy panel's load in flight, per panel, for the host element it was asked for. */
  private lazyPanelLoads = new Map<LazyPanelId, { host: HTMLElement; promise: Promise<void> }>();
  /**
   * Moved by every buildDom. A re-connect replaces the shadow DOM, so a surface or palette load
   * that was in flight for the old markup must land nowhere: each loader captures this before it
   * waits and drops its answer (resolved or rejected) when it no longer matches.
   */
  private domGeneration = 0;
  /** Ends the listeners buildDom put on the shadow root and on the host, before the next build adds its own. */
  private shellListeners: AbortController | undefined;
  /** The strip's View panel: the canvas controls — preview width, render theme, show hidden. */
  private viewPanelEl!: HTMLElement;
  private settingsPanelEl!: HTMLElement;
  /** The data source whose simulated list is open for editing in the Settings panel, and what its box held. */
  private editingSource: { id: string; text: string; error?: string | undefined } | undefined;
  /** What the Settings panel's source list last drew, so a change that moved nothing in it repaints nothing. */
  private sourcesSignature: string | undefined;
  /** Why the host values box was not taken (the box keeps its text, the last good values stay applied); `undefined` when it was. */
  private hostValuesProblem: string | undefined;
  /** The form's rule text the "reads host values" line was last worked out from, so a change that moved nothing costs no scan. */
  private hostReadsSignature: string | undefined;
  /** What the documents dropdown last drew, so a controller change that moves none of it repaints nothing. */
  private documentsSignature: string | undefined;
  private wrapEl!: HTMLDivElement;
  private documentsEl!: HTMLDivElement;
  private modeActionsEl!: HTMLElement;

  private readonly modeMap = new Map<string, BuilderMode>();
  private activeMode: BuilderMode;
  private modeToken = 0;
  private showModeSwitchValue = true;
  private readonly hiddenModes = new Set<string>();
  /** Each mode's canvas surface, kept while the mode is inactive. */
  private readonly surfaces = new Map<BuilderMode, HTMLElement | undefined>();
  /** What each mode's surface says about the canvas bar's tools. */
  private readonly surfaceOptions = new Map<BuilderMode, CanvasSurfaceOptions | undefined>();
  private readonly documentUnsubs = new Map<BuilderMode, () => void>();
  /** How many documents each mode listed when it last told the shell, so a list that empties is seen. */
  private readonly documentCounts = new Map<BuilderMode, number>();
  /** Each mode's subscription to its rows on the Form panel (`BuilderMode.formSettings`). */
  private readonly formSettingsUnsubs = new Map<BuilderMode, () => void>();
  /** Which bar button opened the shared menu popover: the document's menu or the +. */
  private documentMenuOpener: "menu" | undefined;
  private modeStyleEl: HTMLStyleElement | undefined;
  /** The controller the panels and the bar are pointed at, so a re-point is only done on a change. */
  private pointedController: BuilderController | undefined;
  private barUnsub: Array<() => void> = [];
  private activePanel: DatumBuilderPanel | undefined = INITIAL_PANEL;
  /**
   * Whether the Components palette's open or shut state is the shell's own doing: it
   * opens with an empty form to start on and stays shut on one with components, and a click on the
   * canvas puts it away. The author's own move (a strip item, the rail's All components, the
   * `panel` property, a remembered layout) takes the choice, and nothing is written to
   * `persist-panels` until then.
   */
  private autoPalette = true;
  /** The workspace on the page, the last one that is not a designer's, and each one's open panel. */
  private workspaceValue: BuilderWorkspace = "form";
  private lastFormWorkspace: FormWorkspace = "form";
  private readonly workspacePanels = new Map<BuilderWorkspace, DatumBuilderPanel | undefined>();
  private hiddenWorkspacesValue: BuilderWorkspace[] = [];
  /**
   * The `features` list: `undefined` when none was given, where every part of the
   * builder exists; else only the parts it names (and the Form workspace). The list is the master:
   * `hidden-workspaces` and `hidden-panels` only take further parts away.
   */
  private featuresValue: BuilderFeatureSet = undefined;
  /** Strip panels the host leaves off (`hidden-panels`); the ids of SHELL_PANELS. */
  private hiddenPanelsValue: string[] = [];
  private managedSettingsValue: string[] = [];
  private workspaceRestored = false;
  /** Problem counts a host or the wrapper reports per workspace (journey diagnostics, layout rules); Data adds the form's own. */
  private workspaceProblemsValue: Partial<Record<BuilderWorkspace, number>> = {};
  /** The document whose name is being edited in place, in the dropdown's face. */
  private renaming: { mode: BuilderMode; id: string } | undefined;

  private drag: { kind: "side" | "props"; startX: number; startW: number } | undefined;
  private unsub: Array<() => void> = [];
  /** The `persist-panels` key the panels are remembered under; none, nothing is remembered. */
  private persistKey: string | undefined;
  /** Set while a remembered layout is being applied, so applying it is not written back. */
  private restoring = false;
  /** Set once the shell is up and any remembered layout applied: only then are changes written back. */
  private panelsReady = false;
  /** Whether the shell is narrow: the side column and the inspector are drawers. */
  private narrow = false;
  /** Whether the shell is medium: 900px up to 1280px, where one drawer sits beside the canvas. */
  private medium = false;
  /** Set while the palette or another panel drawer has put the inspector away at the medium tier; session only, never written to panel memory. */
  private yieldedProps = false;
  /** Set while the shell closes a drawer on its own (a selection opening the inspector at the medium tier): not remembered. */
  private passing = false;
  /** Set while the shell settles its own palette at connect: the panel changes without announcing it. */
  private quietPanel = false;
  /** The panels as they stood before the shell went narrow, restored when it widens again. */
  private wideState: { panel: DatumBuilderPanel | undefined; propsCollapsed: boolean } | undefined;
  /** Logic's surface, once its chunk has loaded. */
  private logicEl: DatumBuilderLogicElement | undefined;
  /** The plugin functions the host wired, listed with the built-ins everywhere a formula is written. */
  private formulaFunctionsValue: FormulaFunctionsSource | undefined;
  private formulaReferenceHrefValue: string | undefined;
  /** See {@link embedBudget}. */
  private embedBudgetValue: ((extraBytes: number) => DefinitionBudget | undefined) | undefined;
  private textLocaleValue: string | undefined;
  private textCatalogValue: BuilderTextCatalog | undefined;
  /** The builder's words for the shell chrome: the same locale and catalog the panels take. */
  private readonly words = new BuilderWords();

  /**
   * One of the builder's own words by key, in the builder's language (the host's catalog, else
   * the English table). `<datum-form-builder>` draws its loading and failure cards in its own
   * shadow root and asks here, so the cards say what the shell's cards say.
   */
  public shellText(key: string): string {
    return this.words.text(key as BuilderTextKey);
  }
  private logicLoading = false;
  private logicDefinitionSource: (() => FormDefinition | undefined) | undefined;
  /** The command palette, once its chunk has loaded. */
  private paletteEl: DatumBuilderPaletteElement | undefined;
  /** Ids of the commands run last, most recent first (five at most, this page only). */
  private recentCommands: string[] = [];
  private readonly commandSources = new Set<BuilderCommandSource>();
  /** The Journeys and PDF overviews' surface, once its chunk has loaded. */
  private overviewEl: DatumBuilderOverviewElement | undefined;
  private overviewLoading = false;
  private overviewShown = false;
  private designerShown = false;
  /** Set while the form comes back for an overview ("‹ Layouts", a designer tab): the mode change keeps the workspace, on its overview. */
  private returningToOverview = false;
  /** Takes down a mode's popover and styles, put up for an add started from an overview. */
  private overviewAddDown: (() => void) | undefined;
  /** The mode a switch is activating, until it lands or another choice supersedes it. */
  private activating: BuilderMode | undefined;
  /** Set while {@link reflectMode} writes the `mode` attribute, which is the shell's own write and no host's choice. */
  private reflectingMode = false;
  /** The document whose card takes focus once the overview is drawn (its chunk was still loading). */
  private pendingOverviewFocus: { documentId: string | undefined } | undefined;
  /** Data's surface, once its chunk has loaded. */
  private dataEl: DatumBuilderDataElement | undefined;
  private dataLoading = false;
  private languagesEl: DatumBuilderLanguagesElement | undefined;
  private languagesLoading = false;
  /** Print's surface, once its chunk has loaded. */
  private printEl: DatumBuilderPrintElement | undefined;
  private printLoading = false;
  private printThemeValue: PrintTheme | undefined;
  private printSourcesValue: PrintWorkspaceSources | undefined;
  private widthObserver: ResizeObserver | undefined;
  private shellWidth = 0;
  /** The marks {@link highlightComponents} set, until its timer takes them away. */
  private agentHighlight: { root: ShadowRoot; observer: MutationObserver | undefined; timer: ReturnType<typeof setTimeout> } | undefined;
  /** The phone tier: set beside `narrow` by the width observer. */
  private phone = false;
  /** Set while the phone's attributes are on anything, so the first sync off the phone clears them. */
  private phoneTouched = false;
  private menuOpen = false;
  private moreOpen = false;
  private resultsOpen = false;
  /** Surfaces (Logic, Data) whose own editor is up as a sheet: they say so with builder-sheet-change. */
  private readonly surfaceSheets = new Set<Element>();
  /** The sheet the last sync drew, so a change of sheet moves focus once. */
  private sheetKind: PhoneSheet | undefined;
  /** What had focus when the first sheet came up: it gets focus back when the last goes. */
  private sheetOpener: HTMLElement | undefined;
  /** Sheets the author made tall with the handle, for this page only (spec 3.5). */
  private readonly tallSheets = new Set<string>();
  /** Sheets the author shrank with the handle on a small phone, where the default is tall. */
  private readonly shortSheets = new Set<string>();
  /** Whether the phone is a small one (see PHONE_SMALL_WIDTH): framed sheets open tall. */
  private smallPhone = false;
  /** The sheet the gestures are attached to, and what takes them away again (sheet-gestures.ts). */
  private sheetGestureKind: PhoneSheet | undefined;
  private sheetGestureOff: Array<() => void> = [];
  /** The results sheet's own look, adopted into the canvas's shadow root. */
  private resultsSheetStyles: CSSStyleSheet | undefined;
  /** Whether the Try it results sheet is raised to its tall height (the grabber's tap or a drag up). */
  private resultsTall = false;
  /** The bottom bar's items past four, in order, which More lists. */
  private moreItems: HTMLElement[] = [];
  /** Where each host slot moved into the drawer stood on the bar. */
  private hostSlotHomes: Array<{ part: HTMLElement; marker: Comment }> = [];
  private saveStateValue: "saved" | "unsaved" | undefined;
  /** The selection the last syncInspector saw, so a phone tells a new selection from a repaint. */
  private selectionSeen: string | undefined;

  constructor() {
    super();
    this.rootNode = this.attachShadow({ mode: "open" });
    defineBuilderPanels();
    defineBuilderOutline();
    defineBuilderFormFields();
    this.activeMode ={ id: PRIMARY_BUILDER_MODE, label: "Form", controller: this.ctrl };
    this.modeMap.set(PRIMARY_BUILDER_MODE, this.activeMode);
    // The host's catalog, for the grids that show what it overrides (asked of the host's own source).
    this.ctrl.setTranslationCatalog(() => this.hostCatalogData());
    this.syncControllerWords();
    // The journeys' and the PDF layouts' default texts change with the form's, in its one history entry.
    this.ctrl.setOutsideDocuments(() => [...this.modeMap.values()].flatMap((mode) => mode.localeDocument?.() ?? []));
  }

  public connectedCallback(): void {
    // The scheme the author last chose from the menu, unless the page set one.
    // Read once here (and again when the page hands the choice back): a live read in the getter
    // would let another tab's write repaint some surfaces and not others.
    this.rememberedScheme = readSchemeMemory();
    if (!this.hasAttribute("scheme") && this.rememberedScheme === "dark") {
      this.setAttribute("scheme", "dark");
    }
    // The builder's look for the controls a host slots onto it, in the root they live in.
    const hostRoot = this.getRootNode();
    if (isBuilderHostControlRoot(hostRoot)) {
      adoptBuilderHostControlStyles(hostRoot);
    }
    this.buildDom();
    this.wireController();
    // A re-connect rebuilds the DOM: the active mode's chrome comes back with it.
    if (this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      this.attachModeChrome(this.activeMode);
      this.wrapEl.dataset.mode = this.activeMode.id;
      this.applySurface(this.surfaces.get(this.activeMode));
    }
    this.restorePanels();
    // The palette opens on an empty form only, unless a remembered layout (restorePanels) already chose.
    this.settlePalette(true);
    // The workspace: a remembered one (restorePanels) wins over the host's attribute.
    if (!this.workspaceRestored) {
      const wanted = this.getAttribute("workspace");
      if (isWorkspace(wanted) && this.availableWorkspaces().includes(wanted)) {
        this.enterWorkspace(wanted, { fromMode: true });
      }
    }
    this.applyWorkspace();
    this.reflectWorkspace();
    this.syncFullWindow();
    this.schemeAnnounced = this.scheme;
    this.panelsReady = true;
    this.watchWidth();
    this.emitChange("init");
    // A `mode` attribute naming a registered mode is honoured once the shell is up.
    const wanted = this.getAttribute("mode");
    if (wanted && wanted !== this.activeMode.id && this.modeMap.has(wanted)) {
      this.setMode(wanted);
    }
  }

  public disconnectedCallback(): void {
    // Try it ends with the builder: a mode's session is disposed, its answers kept.
    this.endTrying();
    // An assistant's highlight goes with the page too: its timer and its watch on the preview
    // root must not outlive the builder, nor carry their marks into a reattached lifecycle.
    this.endAgentHighlight();
    for (const off of this.unsub) {
      off();
    }
    this.unsub = [];
    this.unbindBar();
    this.panelsReady = false;
    this.widthObserver?.disconnect();
    this.widthObserver = undefined;
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("click", this.onWindowClick);
    window.removeEventListener("click", this.onFileMenuOutside);
    this.shellListeners?.abort();
    this.shellListeners = undefined;
    // A builder taken off the page in full window, or under a sheet, gives the window its scroll back.
    this.disposeSheetGestures();
    this.syncFullWindow();
  }

  // --- public API ---------------------------------------------------

  static get observedAttributes(): string[] {
    return ["layout", "mode", "persist-panels", "workspace", "hidden-workspaces", "hidden-panels", "managed-settings", "features", "full-window", "no-full-window", "scheme", "no-scheme-toggle"];
  }

  public attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "full-window" || name === "no-full-window") {
      this.syncFullWindow();
      return;
    }
    if (name === "scheme" || name === "no-scheme-toggle") {
      // The page handing the choice back: the remembered dark comes back as at connect.
      if (name === "scheme" && value === null && this.wrapEl) {
        this.rememberedScheme = readSchemeMemory();
        if (this.rememberedScheme === "dark") {
          this.setAttribute("scheme", "dark");
          return;
        }
      }
      this.syncScheme();
      return;
    }
    if (name === "hidden-workspaces") {
      this.hiddenWorkspaces = (value ?? "").split(/[\s,]+/).filter(isWorkspace);
      return;
    }
    if (name === "hidden-panels") {
      this.hiddenPanels = (value ?? "").split(/[\s,]+/).filter(Boolean);
      return;
    }
    if (name === "managed-settings") {
      this.managedSettings = (value ?? "").split(/[\s,]+/).filter(Boolean);
      return;
    }
    if (name === "features") {
      this.applyFeatures(value === null ? undefined : parseBuilderFeatures(value));
      return;
    }
    if (name === "workspace") {
      // Before connect: the workspace to open on (connectedCallback; a remembered one wins).
      if (this.wrapEl && isWorkspace(value) && value !== this.workspaceValue && !this.setWorkspace(value)) {
        this.reflectWorkspace();
      }
      return;
    }
    if (name === "persist-panels") {
      // The key is kept whether or not the DOM is up: connectedCallback restores under it.
      this.persistKey = value === null ? undefined : value.trim() || "default";
      if (this.wrapEl) {
        this.restorePanels();
      }
      return;
    }
    // Before connect the DOM is not built yet; buildDom applies the layout itself, and
    // connectedCallback honours the mode.
    if (!this.wrapEl) {
      return;
    }
    if (name === "layout") {
      this.applyLayout();
      return;
    }
    if (name === "mode") {
      const id = value ?? PRIMARY_BUILDER_MODE;
      if (id === this.activeMode.id) {
        // The host naming the mode on the page again: a switch still activating gives way to it,
        // as in setMode. The shell's own write of the attribute (reflectMode) is no choice.
        if (!this.reflectingMode) {
          this.supersedeActivation();
        }
        return;
      }
      // A mode not registered yet is honoured when it is (see addMode). A switch held by the
      // unsaved-edits prompt: the attribute says what is on the page now, and moves when the
      // switch does.
      if (!this.modeMap.has(id)) {
        return;
      }
      if (!this.setMode(id)) {
        this.reflectMode();
      }
    }
  }

  /** The form's controller — the primary mode's. See {@link activeController} for the mode on the page. */
  public get controller(): BuilderController {
    return this.ctrl;
  }

  /**
   * The answers tried on the canvas, as its one store holds them: typed in
   * any workspace's Try it, kept across them. Typed ones only (a calculation's or a default's
   * value is nobody's answer), as kernel JSON; `{}` before the canvas is drawn.
   */
  public triedAnswers(): Record<string, unknown> {
    const state = this.canvasEl?.previewRuntime()?.state();
    if (!state) {
      return {};
    }
    const answers = kernelJsonAnswers(state.values as Record<string, unknown>);
    return Object.fromEntries(Object.entries(answers).filter(([key]) => state.dirty.has(key)));
  }

  /** Empties the answers tried, as Try it's Clear answers does (the PDF preview dialog's Clear). */
  public clearTriedAnswers(): void {
    this.canvasEl?.clearTriedAnswers();
  }

  // --- modes and documents ------------------------

  /**
   * Registers a mode; its tab (or its documents' tabs) appears on the bar. A `mode` attribute naming it takes effect at once.
   * `before` puts it ahead of that registered mode — on the bar, in the dropdown and in the command palette — so a side a host
   * takes away and brings back keeps its place; a name not registered, or the form's, appends it.
   */
  public addMode(mode: BuilderMode, options: { before?: string | undefined } = {}): void {
    if (mode.id === PRIMARY_BUILDER_MODE) {
      throw new Error(`"${PRIMARY_BUILDER_MODE}" is the builder's own mode`);
    }
    if (this.modeMap.has(mode.id)) {
      throw new Error(`A builder mode with the id "${mode.id}" already exists`);
    }
    const before = options.before;
    if (before !== undefined && before !== PRIMARY_BUILDER_MODE && this.modeMap.has(before)) {
      // The map's order is the bar's: rebuilt with the new mode ahead of the one named.
      const registered = [...this.modeMap];
      this.modeMap.clear();
      for (const [id, existing] of registered) {
        if (id === before) {
          this.modeMap.set(mode.id, mode);
        }
        this.modeMap.set(id, existing);
      }
    } else {
      this.modeMap.set(mode.id, mode);
    }
    if (this.formulaFunctionsValue !== undefined) {
      mode.formulaFunctions = this.formulaFunctionsValue;
    }
    // The designer a mode loads reads the builder's words through this, live (a mode given its own keeps it).
    mode.textCatalog ??= () => this.textCatalogValue;
    if (mode.documents) {
      this.documentCounts.set(mode, mode.documents.list().length);
      this.documentUnsubs.set(
        mode,
        mode.documents.subscribe(() => {
          const count = mode.documents?.list().length ?? 0;
          const before = this.documentCounts.get(mode) ?? count;
          this.documentCounts.set(mode, count);
          // The mode on the page lost its last document: there is nothing of it to
          // edit, so the form comes back. A mode opened with none stays, showing its own empty
          // state, and so does one whose page has the form put away (`workspaces="pdf"`,
          // whose last layout can go).
          if (mode === this.activeMode && before > 0 && count === 0 && !this.hiddenModes.has(PRIMARY_BUILDER_MODE)) {
            // Back to the mode's overview, which says there are none and offers New.
            // Focus on the Delete pressed, or already dropped with its menu, lands on the overview.
            const focusHere = this.deepActiveElement() !== undefined || document.activeElement === null || document.activeElement === document.body;
            this.returningToOverview = workspaceForMode(mode.id) === this.workspaceValue;
            this.returnToForm(mode);
            this.renderDocuments();
            if (focusHere) {
              this.rescueFocus(undefined);
            }
            this.emitDocumentChange();
            return;
          }
          this.renderDocuments();
          // A document added or removed by any route: the overview's cards follow.
          if (this.overviewShown) {
            this.overviewEl?.refresh();
          }
          // The mode moved to another document on its own (an addition, a removal): the
          // panels follow its controller.
          if (mode === this.activeMode) {
            this.applyPanelControllers();
          }
        })
      );
    }
    if (mode.formSettings) {
      this.formSettingsUnsubs.set(
        mode,
        mode.formSettings.subscribe(() => this.applyModeSettings())
      );
      this.applyModeSettings();
    }
    this.renderDocuments();
    this.applyWorkspace();
    // A PDF mode arriving takes over Try it's Preview PDF: an open panel says so.
    this.canvasEl?.tryRefresh();
    if (this.wrapEl && this.getAttribute("mode") === mode.id) {
      this.setMode(mode.id);
    }
  }

  /**
   * Removes a mode. The active one is left at once — the host's decision, not held by the
   * guard — and the form comes back on the page; a switch to it still activating lands nothing.
   * The form itself cannot be removed.
   */
  public removeMode(id: string): void {
    if (id === PRIMARY_BUILDER_MODE) {
      throw new Error(`"${PRIMARY_BUILDER_MODE}" is the builder's own mode`);
    }
    const mode = this.modeMap.get(id);
    if (!mode) {
      return;
    }
    if (mode === this.activeMode) {
      this.returnToForm(mode);
    } else if (mode === this.activating) {
      this.supersedeActivation();
    }
    this.modeMap.delete(id);
    this.surfaces.delete(mode);
    this.surfaceOptions.delete(mode);
    this.documentUnsubs.get(mode)?.();
    this.documentUnsubs.delete(mode);
    this.documentCounts.delete(mode);
    const settingsUnsub = this.formSettingsUnsubs.get(mode);
    if (settingsUnsub) {
      settingsUnsub();
      this.formSettingsUnsubs.delete(mode);
      this.applyModeSettings();
    }
    mode.dispose?.();
    // The mode's workspace goes with it: its overview, if on the page, gives way to the form's last workspace.
    if (!this.availableWorkspaces().includes(this.workspaceValue)) {
      this.enterWorkspace(this.formWorkspaceToReturn(), { fromMode: true });
    }
    this.renderDocuments();
    this.applyWorkspace();
    // The PDF mode going takes its Preview PDF out of an open Try it panel.
    this.canvasEl?.tryRefresh();
  }

  /**
   * Takes `mode`, the one on the page, down and puts the form back — at once, not through the
   * unsaved-edits guard: the host removed the mode, or the mode's last document went (and
   * with it anything drafted on it).
   */
  private returnToForm(mode: BuilderMode): void {
    this.endTrying();
    this.modeToken += 1;
    const superseded = this.activating;
    this.activating = undefined;
    this.setDocumentFaceBusy(false);
    mode.deactivate?.();
    this.detachModeChrome(mode);
    this.activeMode = this.modeMap.get(PRIMARY_BUILDER_MODE)!;
    this.takeDownSuperseded(superseded);
    if (this.wrapEl) {
      this.applyPanelControllers();
      this.applySurface(undefined);
      delete this.wrapEl.dataset.mode;
    }
    this.reflectMode();
    this.dispatchEvent(
      new CustomEvent<BuilderModeChangeDetail>("builder-mode-change", {
        detail: { mode: PRIMARY_BUILDER_MODE, previous: mode.id },
        bubbles: true,
        composed: true
      })
    );
  }

  /** Every mode's rows for the Form panel, in the bar's order. */
  private modeSettingsGroups(): FormPanelModeSettings[] {
    const groups: FormPanelModeSettings[] = [];
    for (const mode of this.modeMap.values()) {
      if (mode.id !== PRIMARY_BUILDER_MODE && mode.formSettings) {
        const readOnlyRows = mode.formSettings.readOnlyRows?.() ?? [];
        groups.push({
          mode: mode.id,
          title: mode.formSettings.title,
          rows: mode.formSettings.rows(),
          ...(readOnlyRows.length > 0 ? { readOnlyRows } : {})
        });
      }
    }
    return groups;
  }

  /** Hands the Form panel the modes' rows as they stand; it draws them on the form's own tab. */
  private applyModeSettings(): void {
    if (this.formSettingsEl) {
      this.formSettingsEl.modeSettings = this.modeSettingsGroups();
    }
  }

  /** The registered modes, the form first, as the bar lists them. */
  public get modes(): Array<{ id: string; label: string }> {
    return [...this.modeMap.values()].map((mode) => ({ id: mode.id, label: mode.label }));
  }

  /** The mode on the page. Assigning switches (through the unsaved-edits guard); see {@link setMode}. */
  public get mode(): string {
    return this.activeMode.id;
  }

  public set mode(id: string) {
    this.setMode(id);
  }

  /**
   * Puts the mode with this id on the page, once the active mode's unsaved inspector edits are
   * dealt with (the same prompt as leaving the builder). Returns whether the switch started now.
   */
  public setMode(id: string): boolean {
    const mode = this.modeMap.get(id);
    if (!mode) {
      throw new Error(`No builder mode has the id "${id}"`);
    }
    if (mode === this.activeMode) {
      // The mode already on the page is the author's choice: a switch still activating gives way to it.
      this.supersedeActivation();
      return true;
    }
    // A designer with nothing to design opens on its overview instead, which offers New.
    const workspace = workspaceForMode(id);
    if (workspace && mode.documents && mode.documents.list().length === 0 && !this.hiddenModes.has(PRIMARY_BUILDER_MODE)) {
      return this.setWorkspace(workspace);
    }
    return this.activeMode.controller.requestLeave(() => {
      void this.activateMode(mode);
    });
  }

  /**
   * Puts one of a mode's documents on the page — the mode first, when another is active —
   * once the active controller's unsaved edits are dealt with. Returns whether the switch
   * started now.
   */
  public selectDocument(modeId: string, documentId: string): boolean {
    const mode = this.modeMap.get(modeId);
    if (!mode) {
      throw new Error(`No builder mode has the id "${modeId}"`);
    }
    if (mode !== this.activeMode) {
      return this.activeMode.controller.requestLeave(() => {
        void this.activateMode(mode, documentId);
      });
    }
    if (!mode.documents || mode.documents.selectedId() === documentId) {
      // The document already on the page, as setMode's mode: a switch still activating gives way to it.
      this.supersedeActivation();
      return true;
    }
    return mode.controller.requestLeave(() => {
      void this.moveToDocument(mode, documentId);
    });
  }

  /**
   * A new document (the palette's, a host's `newDocument`): the mode's own add flow (a popover,
   * a dialog). With the mode on the page it is anchored on the document label. A journey or a
   * layout otherwise starts from its workspace's overview, as that overview's New
   * does, once the active controller's unsaved edits are dealt with. Another mode moves the
   * page to it first, its chrome being up only while it is active; the label is looked up when
   * the flow starts, since the switch redraws it.
   */
  private addDocument(mode: BuilderMode, kind?: string): void {
    const add = mode.documents?.add;
    if (!add) {
      return;
    }
    if (mode === this.activeMode) {
      // The new document is selected once made: unsaved edits on the one on the page are settled first.
      mode.controller.requestLeave(() => {
        if (this.activeMode === mode) {
          void add(this.addAnchor(), kind);
        }
      });
      return;
    }
    // A designer's mode adds from its overview: the workspace's overview, the flow over it.
    const workspace = workspaceForMode(mode.id);
    if (workspace && this.availableWorkspaces().includes(workspace) && !this.hiddenModes.has(PRIMARY_BUILDER_MODE)) {
      this.activeController.requestLeave(() => {
        this.enterWorkspace(workspace);
        void this.addFromOverview(mode, undefined, kind);
      });
      return;
    }
    this.activeMode.controller.requestLeave(() => {
      void this.activateMode(mode).then(() => {
        if (this.activeMode === mode) {
          void add(this.addAnchor(), kind);
        }
      });
    });
  }

  /**
   * An overview's New: the mode's add flow over the overview, the form still the
   * page's mode. Only the mode's overlays and styles go up for it. The designer opens on the
   * document made; a flow left with nothing made leaves the overview as it was.
   */
  private async addFromOverview(mode: BuilderMode, anchor: HTMLElement | undefined, kind?: string): Promise<void> {
    const documents = mode.documents;
    if (!documents?.add) {
      return;
    }
    if (mode === this.activeMode) {
      void documents.add(anchor, kind);
      return;
    }
    try {
      await documents.prepareAdd?.();
    } catch {
      // The flow reports its own failure to load when it starts.
    }
    if (mode === this.activeMode || this.modeMap.get(mode.id) !== mode) {
      return;
    }
    this.overviewAddDown?.();
    const overlays = mode.overlays ?? [];
    const style = document.createElement("style");
    style.setAttribute("data-mode-style", `${mode.id}-add`);
    style.textContent = mode.styles ?? "";
    this.rootNode.append(...overlays, style);
    for (const overlay of overlays) {
      if (this.shellWidth > 0) {
        overlay.style.setProperty("--db-shell-w", `${this.shellWidth}px`);
      }
    }
    let ended = false;
    // A mode that never calls onEnd still opens its new document: the list gains it.
    const known = new Set(documents.list().map((entry) => entry.id));
    const unsubscribe = documents.subscribe(() => {
      const made = documents.list().find((entry) => !known.has(entry.id));
      if (made) {
        end(made.id);
      }
    });
    const down = (): void => {
      unsubscribe();
      if (this.overviewAddDown === down) {
        this.overviewAddDown = undefined;
      }
      style.remove();
      // Once the mode is on the page its chrome is its own again.
      if (this.activeMode !== mode) {
        for (const overlay of overlays) {
          overlay.remove();
        }
      }
    };
    this.overviewAddDown = down;
    const end = (documentId: string | undefined): void => {
      if (ended) {
        return;
      }
      ended = true;
      down();
      if (documentId !== undefined && this.modeMap.get(mode.id) === mode) {
        // On an overview the form holds no unapplied draft (entering the workspace asked), so nothing is at stake.
        void this.activateMode(mode, documentId);
      }
    };
    try {
      await documents.add(anchor, kind, { fromOverview: true, onEnd: end });
    } catch {
      end(undefined);
    }
  }

  /**
   * Starts a new document in a mode (a journey, a PDF layout): the mode's own
   * add flow, as an overview's New and the command palette start it, its popover under the
   * bar's document label. `kind` is one of the mode's `addKinds`; without it the mode offers
   * every kind. Returns whether the mode can add.
   */
  public newDocument(modeId: string, kind?: string): boolean {
    const mode = this.modeMap.get(modeId);
    if (!mode?.documents?.add || this.hiddenModes.has(modeId)) {
      return false;
    }
    this.addDocument(mode, kind);
    return true;
  }

  /**
   * The server's checks Try it can run on the answers tried: a host's WebAssembly
   * sandbox, say. In hand or as a loader, called the first time the author turns it on. Unset, Try it checks in the browser alone.
   */
  public get serverChecks(): TryItServerChecksSource | undefined {
    return this.serverChecksValue;
  }

  public set serverChecks(value: TryItServerChecksSource | undefined) {
    this.serverChecksValue = value;
    if (this.canvasEl) {
      this.canvasEl.serverChecks = value;
    }
  }

  /** What Try it's Preview PDF renders with (the host's PDF provider and fonts). Unset, Try it offers no PDF. */
  public get tryPdf(): TryItPdfSource | undefined {
    return this.tryPdfValue;
  }

  public set tryPdf(value: TryItPdfSource | undefined) {
    this.tryPdfValue = value;
    if (this.canvasEl) {
      this.canvasEl.tryPdf = value;
    }
  }

  /** Where a new document's popover opens: under the document label, the bar's centre, at every width. */
  private addAnchor(): HTMLElement | undefined {
    return this.rootNode.querySelector<HTMLElement>("[data-document-face]") ?? undefined;
  }

  // --- workspaces -----------------------------------------------

  /** The workspace on the page. Assigning switches through the unsaved-edits guard; see {@link setWorkspace}. */
  public get workspace(): BuilderWorkspace {
    return this.workspaceValue;
  }

  public set workspace(id: BuilderWorkspace) {
    this.setWorkspace(id);
  }

  /** Workspaces the host leaves off the bar (`hidden-workspaces`); the one on the page is left for the first shown. */
  public get hiddenWorkspaces(): BuilderWorkspace[] {
    return [...this.hiddenWorkspacesValue];
  }

  public set hiddenWorkspaces(value: BuilderWorkspace[]) {
    this.hiddenWorkspacesValue = (value ?? []).filter(isWorkspace);
    if (!this.wrapEl) {
      return;
    }
    const available = this.availableWorkspaces();
    if (!available.includes(this.workspaceValue) && available[0]) {
      this.leaveRemovedWorkspace(available[0]);
    }
    this.applyWorkspace();
  }

  /**
   * Problems to count on the workspace tabs: what a host or the wrapper finds,
   * per workspace — the journeys' diagnostics for Journeys, loaded when the page is idle, and the
   * layouts' rule problems for PDF. Data adds
   * the form's own data-key problems. Until something is reported a tab shows no count, never a
   * spinner, and nothing waits on it.
   */
  public get workspaceProblems(): Partial<Record<BuilderWorkspace, number>> {
    return { ...this.workspaceProblemsValue };
  }

  public set workspaceProblems(value: Partial<Record<BuilderWorkspace, number>>) {
    this.workspaceProblemsValue = { ...(value ?? {}) };
    this.applyWorkspaceCounts();
  }

  /** A workspace's name on the bar, in the builder's words. */
  private workspaceLabel(id: BuilderWorkspace): string {
    return this.words.text(`shell.workspace.${id}`);
  }

  /** A mode's name: its workspace's words for the form and the designers, else the mode's own label. */
  private modeLabel(mode: BuilderMode): string {
    if (mode.id === PRIMARY_BUILDER_MODE) {
      return this.workspaceLabel("form");
    }
    const workspace = workspaceForMode(mode.id);
    return workspace ? this.workspaceLabel(workspace) : mode.label;
  }

  /** A card the surface's host shows while its chunk loads or when it fails (Retry). */
  private loadingCard(key: BuilderTextKey): string {
    return `<div class="logic-state" role="status"><p>${escapeHtml(this.words.text(key))}</p></div>`;
  }

  /**
   * A lazy surface that did not arrive (or could not be wired): its failure card with Retry in the
   * surface's place, and the host told as `datum-error` {message, cause} (absent-code
   * resilience), so a deleted or blocked chunk is neither a blank area nor silent.
   */
  private surfaceFailed(host: HTMLElement, key: BuilderTextKey, retryAttribute: string, cause: unknown): void {
    host.innerHTML = this.failedCard(key, retryAttribute);
    this.reportFailure(this.words.text(key), cause);
  }

  private reportFailure(message: string, cause: unknown): void {
    this.dispatchEvent(new CustomEvent("datum-error", { bubbles: true, composed: true, detail: { code: "file.unavailable", message, cause } }));
  }

  private failedCard(key: BuilderTextKey, retryAttribute: string): string {
    return `<div class="logic-state" role="alert"><p><strong>${escapeHtml(this.words.text(key))}</strong></p><p>${escapeHtml(this.words.text("shell.load.check"))}</p><button type="button" class="btn" ${retryAttribute}>${escapeHtml(this.words.text("shell.load.retry"))}</button></div>`;
  }

  /** The count drawn on each tab: the reported problems, and for Data the form's data-key clashes. */
  private applyWorkspaceCounts(): void {
    if (!this.wrapEl) {
      return;
    }
    for (const tab of this.rootNode.querySelectorAll<HTMLElement>("[data-workspace-tab]")) {
      const id = tab.dataset.workspaceTab as BuilderWorkspace;
      const count = (this.workspaceProblemsValue[id] ?? 0) + (id === "data" ? this.ctrl.dataKeyProblems().length : 0);
      let badge = tab.querySelector<HTMLElement>(".workspace-count");
      if (count > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "workspace-count";
          badge.setAttribute("aria-hidden", "true");
          tab.append(badge);
        }
        badge.textContent = String(count);
        tab.setAttribute("aria-label", this.words.text("phoneMenu.row", { label: this.workspaceLabel(id), problems: this.words.plural("problems.count", count) }));
      } else {
        badge?.remove();
        tab.removeAttribute("aria-label");
      }
    }
    this.syncTopRow();
  }

  /**
   * The workspaces the bar offers: those the `features` list allows (every one without a list),
   * not hidden by the host, and Journeys or PDF only while that mode is registered.
   */
  public availableWorkspaces(): BuilderWorkspace[] {
    return BUILDER_WORKSPACES.filter(
      (id) =>
        workspaceAllowed(this.featuresValue, id) &&
        !this.hiddenWorkspacesValue.includes(id) &&
        (!isDesignerWorkspace(id) || this.modeMap.has(DESIGNER_WORKSPACES[id]))
    );
  }

  /**
   * The form workspace to go back to when a designer's mode leaves the page: the last one the
   * author was on, unless the `features` list has since taken it away (then the Form workspace),
   * so an excluded workspace is never entered, and its chunk never fetched.
   */
  private formWorkspaceToReturn(): BuilderWorkspace {
    const available = this.availableWorkspaces();
    if (available.includes(this.lastFormWorkspace)) {
      return this.lastFormWorkspace;
    }
    return available.includes("form") ? "form" : (available.find((id) => !isDesignerWorkspace(id)) ?? "form");
  }

  // --- features ----------------------------------------------------

  /**
   * The optional parts of the builder that exist, as one list (the `features` attribute,
   * normalised: the parts in a fixed order separated by spaces, `all` or `minimal` when it is
   * either). Without a list (`undefined`, `null`, no attribute) every part exists, as before the
   * attribute was added; with one, only the parts it names do, besides the Form workspace with
   * its canvas, its inspector and its component palette. The list is the master: `hidden-workspaces`
   * and `hidden-panels` only take more away. Assigning a string or an array of tokens sets the
   * attribute; a change after the builder is up rebuilds what it touches (the workspaces, the strip,
   * the bar, the inspector), and the chunks of a part left out are never fetched. See `builder-features.ts`.
   */
  public get features(): string | undefined {
    return normalizeBuilderFeatures(this.getAttribute("features"));
  }

  public set features(value: string | readonly string[] | null | undefined) {
    if (value === undefined || value === null) {
      this.removeAttribute("features");
      return;
    }
    const text = typeof value === "string" ? value : value.join(" ");
    if (this.getAttribute("features") !== text) {
      this.setAttribute("features", text);
    }
  }

  /**
   * Whether an optional part of the builder exists: always without a `features` list, except an
   * opt-in token such as `agent`, which is never on without a list; else only when the
   * list names it.
   */
  public featureEnabled(feature: BuilderFeature): boolean {
    return featureOn(this.featuresValue, feature);
  }

  /**
   * The key a text is read under where the builder leaves a part out: with Try it
   * off the canvas offers "Preview", so the bar, the menu and the commands say Preview too, not
   * Try it; with Logic off the View panel's hidden-components row does not speak of rules.
   */
  private textKey(key: BuilderTextKey): BuilderTextKey {
    const previewOnly = !this.featureEnabled("try-it");
    const noRules = !this.featureEnabled("logic");
    switch (key) {
      case "shell.bottom.try":
        return previewOnly ? "shell.bottom.preview" : key;
      case "shell.menu.tryIt":
        return previewOnly ? "shell.menu.preview" : key;
      case "shell.command.tryIt":
        return previewOnly ? "shell.command.preview" : key;
      case "shell.sheet.results":
        return previewOnly ? "shell.sheet.results.preview" : key;
      case "shell.sheet.try":
        return previewOnly ? "shell.sheet.try.preview" : key;
      case "view.showHidden.label":
        return noRules ? "view.showHidden.label.noLogic" : key;
      case "view.showHidden.note":
        return noRules ? "view.showHidden.note.noLogic" : previewOnly ? "view.showHidden.note.preview" : key;
      default:
        return key;
    }
  }

  /**
   * Strip panels the host leaves off (`hidden-panels`): ids of the shell's own panels — `form`,
   * `chrome`, `components`, `fields`, `outline`, `variables`, `tests`, `view`, `settings`. A hidden
   * panel is never loaded, nor the one open (the workspace's own opens instead), and its item is
   * not on the strip. Works with or without `features`, which it can only restrict.
   */
  public get hiddenPanels(): string[] {
    return [...this.hiddenPanelsValue];
  }

  public set hiddenPanels(value: string[]) {
    this.hiddenPanelsValue = [...new Set((value ?? []).map((id) => String(id).trim()).filter((id) => id !== ""))];
    this.syncFeatures();
  }

  /**
   * Settings the host manages (`managed-settings`): property paths, or the
   * short `answersFree` for `data.answersFree`. The inspector draws a "managed by the site" note
   * in place of each box; the stored value is never touched. None by default.
   */
  public get managedSettings(): string[] {
    return [...this.managedSettingsValue];
  }

  public set managedSettings(value: string[]) {
    this.managedSettingsValue = [...new Set((value ?? []).map((id) => String(id).trim()).map((id) => (id === "answersFree" ? "data.answersFree" : id)).filter((id) => id !== ""))];
    if (this.wrapEl) {
      this.propertiesEl.managedSettings = this.managedSettingsValue;
      this.formSettingsEl.managedSettings = this.managedSettingsValue;
    }
  }

  private applyFeatures(next: BuilderFeatureSet): void {
    this.featuresValue = next;
    this.syncFeatures();
  }

  /** Whether the panel is left off the strip: by the `features` list or by `hidden-panels`. A host's own panels are never. */
  private panelOff(id: string | undefined): boolean {
    return id !== undefined && SHELL_PANELS.some((panel) => panel.id === id) && (!panelAllowed(this.featuresValue, id) || this.hiddenPanelsValue.includes(id));
  }

  /** The panel to open for the one asked: itself, or the workspace's own when it is left off (none when that is too). */
  private usablePanel(panel: DatumBuilderPanel | undefined): DatumBuilderPanel | undefined {
    if (!this.panelOff(panel) && !(panel === "fields" && !this.fieldsOffered())) {
      return panel;
    }
    const fallback = WORKSPACE_DEFAULT_PANEL[this.workspaceValue];
    return fallback !== undefined && !this.panelOff(fallback) ? fallback : undefined;
  }

  /** Whether the strip's item for a shell panel is put away: the panel is left off, or the tab offers no such panel. */
  private stripItemHidden(panel: ShellPanel): boolean {
    if (this.panelOff(panel.id)) {
      return true;
    }
    // The header and footer are the form's: another mode's document has none.
    if (panel.id === "chrome") {
      return this.activeMode.id !== PRIMARY_BUILDER_MODE;
    }
    // The form's fields are offered beside a journey's step, while the mode draws one (the Step view).
    if (panel.id === "fields") {
      return !this.fieldsOffered();
    }
    return false;
  }

  /** The mode whose findings the root panel's card draws, and the way its notices are heard. */
  private findingsMode: BuilderMode | undefined;
  private findingsOff: (() => void) | undefined;

  /** Points the root panel's findings card at the mode on the page (`BuilderMode.findings`): none on a mode without them. */
  private watchFindings(): void {
    const mode = this.activeMode;
    if (mode !== this.findingsMode) {
      this.findingsOff?.();
      this.findingsMode = mode;
      this.findingsOff = mode.subscribeFindings?.(() => this.syncFindings());
    }
    this.syncFindings();
  }

  private syncFindings(): void {
    if (this.formSettingsEl) {
      this.formSettingsEl.modeFindings = this.activeMode.findings?.() ?? [];
      this.formSettingsEl.modeChoices = this.activeMode.rootChoices?.() ?? [];
    }
  }

  /** Whether the mode on the page offers the Form fields panel now (a journey's Step view is up). */
  private fieldsOffered(): boolean {
    return this.activeMode.formFields?.offered() === true;
  }

  /**
   * Points the Form fields panel at the mode on the page and hears when the mode's offer changes
   * (the Step view going up or down): the strip's item follows, and an open panel gives way to
   * the workspace's own once it is no longer offered.
   */
  private watchFormFields(): void {
    const source = this.activeMode.formFields;
    if (source === this.fieldsSource) {
      return;
    }
    this.fieldsOff?.();
    this.fieldsSource = source;
    this.fieldsEl.fields = source;
    this.fieldsOff = source?.subscribe(() => this.syncFieldsOffer());
    this.syncFieldsOffer();
  }

  private syncFieldsOffer(): void {
    if (!this.wrapEl) {
      return;
    }
    this.syncStripItems();
    const open = this.usablePanel(this.activePanel);
    if (open !== this.activePanel) {
      this.setPanel(open);
    }
    this.syncPhone();
  }

  private syncStripItems(): void {
    for (const panel of SHELL_PANELS) {
      const item = this.rootNode?.querySelector<HTMLElement>(`[data-strip] [data-panel="${panel.id}"]`);
      if (item) {
        item.hidden = this.stripItemHidden(panel);
      }
    }
  }

  /**
   * Brings the shell in line with the `features` list and `hidden-panels` (a change after connect
   * included): a workspace left off gives way to the first one that is on, the strip loses the
   * items of panels left off and an open one gives way to the workspace's own, and the bar, the
   * canvas, the inspector and the surfaces lose the parts the list leaves out. No chunk is
   * fetched for any of it.
   */
  private syncFeatures(): void {
    if (!this.wrapEl) {
      return;
    }
    const available = this.availableWorkspaces();
    if (!available.includes(this.workspaceValue) && available[0]) {
      this.leaveRemovedWorkspace(available[0]);
    }
    // The way back from a designer must not lead to a workspace the list no longer allows.
    if (!available.includes(this.lastFormWorkspace)) {
      this.lastFormWorkspace = "form";
    }
    this.syncStripItems();
    const open = this.usablePanel(this.activePanel);
    if (open !== this.activePanel) {
      this.setPanel(open);
    }
    this.syncFeatureParts();
    this.applyWorkspace();
    this.renderAddRail();
  }

  /** The parts of the bar, the canvas, the inspector and the surfaces that a feature owns; idempotent, so any repaint may call it. */
  private syncFeatureParts(): void {
    if (!this.wrapEl) {
      return;
    }
    const on = (feature: BuilderFeature): boolean => featureOn(this.featuresValue, feature);
    const palette = this.rootNode.querySelector<HTMLElement>("[data-palette-open]");
    if (palette) {
      palette.hidden = !on("palette");
    }
    if (!on("palette") && this.paletteEl?.isOpen) {
      this.paletteEl.close();
    }
    this.canvasEl.canvasFeatures = { tryIt: on("try-it"), logic: on("logic") };
    this.syncTestsPanelFeatures();
    this.applyFeatureWords();
    // The parts a workspace owns go with its feature: Download as PDF with pdf, the On paper
    // group with print, Formulas with logic.
    const inspector = {
      json: on("json"),
      translations: on("translations"),
      advancedFields: on("advanced-fields"),
      headerFooter: on("header-footer"),
      pdf: on("pdf"),
      print: on("print"),
      logic: on("logic")
    };
    this.propertiesEl.managedSettings = this.managedSettingsValue;
    this.formSettingsEl.managedSettings = this.managedSettingsValue;
    this.propertiesEl.inspectorFeatures = inspector;
    this.formSettingsEl.inspectorFeatures = inspector;
    // Rules are Logic's: the inspector's Rules tab goes with the feature, whatever the mode offers.
    const rules = this.activeMode.inspector?.rules !== false && on("logic");
    this.propertiesEl.showRulesTab = rules;
    this.formSettingsEl.showRulesTab = rules;
    // What Submit does while the form is tried is Try it's.
    const submit = this.rootNode.querySelector<HTMLElement>("[data-settings-submit]");
    if (submit) {
      submit.hidden = !on("try-it");
    }
    const hostValues = this.rootNode.querySelector<HTMLElement>("[data-settings-host]");
    if (hostValues) {
      hostValues.hidden = !on("try-it");
    }
    this.syncSurfaceFeatures();
  }

  /** The words that depend on a feature (see {@link textKey}), written again as the `features` list changes; a value already there costs no paint. */
  private applyFeatureWords(): void {
    const selector = [...FEATURE_WORD_KEYS].map((key) => `[data-t="${key}"]`).join(", ");
    for (const element of this.rootNode.querySelectorAll<HTMLElement>(selector)) {
      const text = this.words.text(this.textKey(element.dataset.t as BuilderTextKey));
      if (element.textContent !== text) {
        element.textContent = text;
      }
    }
  }

  /**
   * The parts of the lazy surfaces that a feature owns, by the properties they read before they
   * draw: the Data surface's import (`data-model`) and its Schema and Example views, and
   * the Header & footer panel's JSON menu. The JSON views are what would fetch the editor's chunk,
   * so with `json` left out no view is there to ask. A value the surface already has costs no paint.
   */
  private syncSurfaceFeatures(): void {
    const dataModel = featureOn(this.featuresValue, "data-model");
    const json = featureOn(this.featuresValue, "json");
    if (this.dataEl) {
      this.dataEl.importEnabled = dataModel;
      this.dataEl.jsonEnabled = json;
    }
    if (this.chromePanelEl) {
      this.chromePanelEl.jsonEnabled = json;
      this.chromePanelEl.translationsEnabled = featureOn(this.featuresValue, "translations");
    }
    if (this.logicEl) {
      this.logicEl.openableDocuments = { pdf: featureOn(this.featuresValue, "pdf"), journeys: featureOn(this.featuresValue, "journeys") };
      // The Tests feature decides whether the surface has a Pinned-by line at all.
      this.feedTestsPins();
    }
    if (this.printEl) {
      this.printEl.testsEnabled = featureOn(this.featuresValue, "tests");
    }
  }

  /**
   * Puts a workspace on the page once the active controller's unsaved edits are dealt with (the
   * Apply / Discard / Stay prompt). Journeys and PDF open on their
   * overview, the form back on the page; the others bring the form back too. Returns whether the
   * switch started now.
   */
  public setWorkspace(id: BuilderWorkspace): boolean {
    // A switch of the author's own is not for a filter an earlier "Open in Languages" left waiting
    // behind a prompt the author then stayed on.
    this.languagesFocus = undefined;
    return this.switchWorkspace(id);
  }

  /**
   * Leaves a workspace the host has just taken away (`features`, `hidden-workspaces`). The host
   * decided, so the author is not asked: what the removed workspace holds unapplied is discarded
   * through that surface's own discard (which clears its pending state and its guard), and the
   * move is made at once. A Stay would leave the author inside a workspace the bar no longer
   * offers. Nothing else is discarded: a draft in the inspector or a scenario in the Tests panel,
   * which stay open beside the workspace the author lands on, are not the removed workspace's.
   */
  private leaveRemovedWorkspace(target: BuilderWorkspace): void {
    this.languagesFocus = undefined;
    if (this.workspaceValue === "languages") {
      this.languagesEl?.discardPending();
    } else if (this.workspaceValue === "logic") {
      this.logicEl?.discardPending();
    }
    this.enterWorkspace(target);
  }

  private switchWorkspace(id: BuilderWorkspace): boolean {
    if (!isWorkspace(id) || !this.availableWorkspaces().includes(id)) {
      return false;
    }
    if (id === this.workspaceValue) {
      return true;
    }
    return this.activeController.requestLeave(() => {
      this.enterWorkspace(id);
      // The leave guard may have held the switch behind its prompt: the run that follows the
      // answer is what puts Languages on the page, so it is also what tells the surface (the
      // surface's chunk, when it is not loaded yet, hears it when it arrives: see syncLanguages).
      if (id === "languages") {
        this.deliverLanguagesFocus();
      }
    });
  }

  /**
   * Languages, past the guard, filtered to one component or one header or footer part:
   * where a panel's "Open in Languages" line leads. The surface hears
   * `builder-languages-goto` on itself and filters its texts to it. The focus is kept while the
   * leave guard holds the switch behind its prompt, and while the surface's chunk is not on the
   * page yet (see {@link syncLanguages}); it is dropped only when there is no Languages
   * workspace to go to.
   */
  private openLanguagesFor(focus: BuilderLanguagesGotoDetail): void {
    if (!this.availableWorkspaces().includes("languages")) {
      this.languagesFocus = undefined;
      return;
    }
    this.languagesFocus = focus;
    this.switchWorkspace("languages");
    // Already on the page (or the switch is a no-op): the surface is told now.
    this.deliverLanguagesFocus();
  }

  /** What Languages was asked to show (a component, or a header or footer part), until the surface has heard of it. */
  private languagesFocus: BuilderLanguagesGotoDetail | undefined;

  private deliverLanguagesFocus(): void {
    const detail = this.languagesFocus;
    if (detail === undefined || this.languagesEl === undefined || this.workspaceValue !== "languages") {
      return;
    }
    this.languagesFocus = undefined;
    this.languagesEl.dispatchEvent(new CustomEvent<BuilderLanguagesGotoDetail>("builder-languages-goto", { detail }));
  }

  /** Form, past the guard, then `then` there: where Languages sends the author to change a thing. */
  private leaveLanguagesFor(then: () => void): void {
    if (!this.availableWorkspaces().includes("form")) {
      return;
    }
    this.activeController.requestLeave(() => {
      this.enterWorkspace("form");
      then();
    });
  }

  /**
   * The switch itself, past the guard. From a mode change (`fromMode`) the mode is already right;
   * otherwise the form comes back on the page: a form workspace edits it, and Journeys and PDF
   * open on their overview, the form the page's mode until a card opens a designer.
   */
  private enterWorkspace(id: BuilderWorkspace, options: { fromMode?: boolean } = {}): void {
    const previous = this.workspaceValue;
    if (id === previous) {
      return;
    }
    // Try it belongs to the canvas it was started on: it never carries into another workspace.
    this.endTrying();
    // Read before the switch: applyWorkspace below takes the overview down.
    const fromOverview = isDesignerWorkspace(previous) && this.overviewShown;
    this.workspacePanels.set(previous, this.activePanel);
    this.workspaceValue = id;
    if (!isDesignerWorkspace(id)) {
      this.lastFormWorkspace = id;
    }
    if (!options.fromMode) {
      // The author's choice wins over a designer still activating (an overview card's Open whose chunk is coming).
      this.supersedeActivation();
    }
    if (!options.fromMode && this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      // From a designer: the form back; into a designer's workspace (the other one's tab), on its overview.
      this.bringFormBack(isDesignerWorkspace(id));
    }
    if (this.phone) {
      // A phone opens every workspace with no sheet up: the Form's inspector, Try it and its results stay behind.
      this.putPhoneSheetsAway();
    }
    this.applyWorkspace();
    // The open panel stays when the new workspace offers it too (the palette from Form into a PDF
    // layout); otherwise the workspace's own: the one last open there, else its default.
    const open = this.activePanel;
    const shellPanel = SHELL_PANELS.find((entry) => entry.id === open);
    const offered = open !== undefined && (shellPanel ? shellPanel.workspaces.includes(id) : this.hostPanels().some((hosted) => hosted.dataset.panel === open));
    // From an overview, whatever is opened opens bare: no panel is chosen for the author.
    if ((isDesignerWorkspace(id) && this.activeMode.id === PRIMARY_BUILDER_MODE) || fromOverview || this.phone) {
      // An overview has no drawer of its own; a phone opens every workspace on a clear canvas.
      this.setPanel(undefined);
    } else if (!offered) {
      this.setPanel(this.workspacePanels.has(id) ? this.workspacePanels.get(id) : WORKSPACE_DEFAULT_PANEL[id]);
    }
    if (this.propertiesEl) {
      this.propertiesEl.inspectorTab = id === "logic" ? "rules" : "properties";
    }
    this.reflectWorkspace();
    this.savePanels();
    this.dispatchEvent(
      new CustomEvent<BuilderWorkspaceChangeDetail>("builder-workspace-change", { detail: { workspace: id, previous }, bubbles: true, composed: true })
    );
  }

  /** Draws the workspace on the bar and the strip: the current tab, the menu, the items it owns. */
  /**
   * Logic's surface: shown while Logic is on, its chunk loaded the first time, a
   * card with Retry when the load fails. It gets the form's controller and the
   * whole definition (for the journeys' and layouts' rules it lists read-only).
   */
  private syncLogic(): void {
    const host = this.rootNode?.querySelector<HTMLElement>("[data-logic-host]");
    if (!host) {
      return;
    }
    const on = this.workspaceValue === "logic";
    host.hidden = !on;
    if (!on) {
      return;
    }
    if (this.logicEl) {
      this.logicEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      this.feedTestsPins();
      this.flushPendingRuleOpen();
      return;
    }
    if (this.logicLoading) {
      return;
    }
    this.logicLoading = true;
    host.innerHTML = this.loadingCard("shell.load.logic");
    const generation = this.domGeneration;
    loadLogicSurface().then(
      (module) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.logicLoading = false;
        try {
          const element = document.createElement(module.DATUM_BUILDER_LOGIC_TAG) as DatumBuilderLogicElement;
          // It declares the token defaults on its own host: the theme goes on it too (themeTargets).
          this.paintThemeVars(element);
          element.definition = () => this.logicDefinitionSource?.();
          element.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
          element.openableDocuments = { pdf: featureOn(this.featuresValue, "pdf"), journeys: featureOn(this.featuresValue, "journeys") };
          host.replaceChildren(element);
          this.logicEl = element;
          this.applyFormulaFunctions();
          element.toggleAttribute("data-phone", this.phone);
          this.feedTestsPins();
          // The selection carries over: its rule opens, when it has one.
          const selected = element.controller?.selectedComponentId();
          if (selected !== undefined) {
            element.openRuleFor(selected);
          }
          // A rule the Tests panel asked for wins over the selection's.
          this.flushPendingRuleOpen();
        } catch (cause) {
          this.logicEl = undefined;
          this.surfaceFailed(host, "shell.load.failed.logic", "data-logic-retry", cause);
        }
      },
      (cause: unknown) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.logicLoading = false;
        this.surfaceFailed(host, "shell.load.failed.logic", "data-logic-retry", cause);
      }
    );
  }

  /**
   * Opens the command palette: every command the builder offers, filtered as you type,
   * each running the same method its control runs. Resolves once it is open; its chunk loads the
   * first time. Focus returns where it was when it closes. Without the `palette` feature
   * it does nothing and resolves at once with `undefined`; `registerCommands` still accepts a
   * source, which is never read.
   */
  public async openPalette(): Promise<void> {
    // Without the `palette` feature there is no palette: a no-op, resolving with
    // nothing, and the palette's chunk is never fetched.
    if (!this.featureEnabled("palette")) {
      return;
    }
    const opener = (this.rootNode.activeElement as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
    const generation = this.domGeneration;
    if (!this.paletteEl) {
      let module: Awaited<ReturnType<typeof loadCommandPalette>>;
      try {
        module = await loadCommandPalette();
      } catch (cause) {
        if (generation !== this.domGeneration) {
          return;
        }
        // Ctrl+K calls this with `void`: say it here, the next Ctrl+K retries.
        this.reportFailure(this.words.text("shell.palette.failed"), cause);
        return;
      }
      // A reconnect while the chunk loaded: this call belongs to markup that is gone. The person
      // asks again (Ctrl+K), and the palette then lands in the live root.
      if (generation !== this.domGeneration) {
        return;
      }
      if (!this.paletteEl) {
        this.paletteEl = document.createElement(module.DATUM_BUILDER_PALETTE_TAG) as DatumBuilderPaletteElement;
        this.paintThemeVars(this.paletteEl);
        this.paletteEl.toggleAttribute("data-phone", this.phone);
        this.rootNode.append(this.paletteEl);
        this.applyPanelTexts();
      }
    }
    if (this.paletteEl.isOpen) {
      return;
    }
    this.paletteEl.open({
      commands: this.paletteCommands(),
      recent: this.recentCommands,
      onRun: (id) => {
        this.recentCommands = [id, ...this.recentCommands.filter((entry) => entry !== id)].slice(0, 5);
      },
      onClose: () => {
        if (opener?.isConnected) {
          opener.focus();
        }
      }
    });
  }

  /**
   * Adds a host's own commands to the palette (Save, Publish, Sign): read each time it
   * opens. Returns the way to take them out again.
   */
  public registerCommands(source: BuilderCommandSource): () => void {
    this.commandSources.add(source);
    return () => {
      this.commandSources.delete(source);
    };
  }

  /**
   * Every command the palette offers now, derived from what the builder has rather than kept by
   * hand: the workspaces, the types the active tree can add, its components, the edits on the
   * selection, the documents, the panels and views, then the host's.
   */
  private paletteCommands(): BuilderCommand[] {
    const commands: BuilderCommand[] = [];
    const controller = this.activeMode.controller;
    const hasSelection = (): boolean => {
      const id = this.activeMode.controller.selectedComponentId();
      return id !== undefined && id !== this.activeMode.controller.rootId();
    };
    for (const id of this.availableWorkspaces()) {
      commands.push({
        id: `workspace:${id}`,
        label: this.words.text("shell.command.workspace", { workspace: this.workspaceLabel(id) }),
        group: "workspaces",
        keywords: [this.workspaceLabel(id)],
        enabled: () => this.workspaceValue !== id,
        run: () => {
          this.setWorkspace(id);
        }
      });
    }
    for (const entry of controller.offeredTypes()) {
      commands.push({
        id: `add:${entry.type}`,
        label: this.words.text("shell.command.add", { type: entry.label }),
        group: "add",
        keywords: [entry.type],
        run: () => {
          const current = this.activeMode.controller;
          const at = current.selectedComponentId();
          current.requestAddAfter(entry.type, at !== undefined && at !== current.rootId() ? at : undefined);
        }
      });
    }
    const walk = (view: ReturnType<BuilderController["treeView"]>): void => {
      for (const slot of view.slots) {
        for (const child of slot.children) {
          commands.push({
            id: `go:${child.id}`,
            label: this.words.text("shell.command.go", { name: child.label || child.id }),
            group: "go to",
            keywords: [child.id, child.type],
            run: () => {
              this.activeMode.controller.requestSelect(child.id);
            }
          });
          walk(child);
        }
      }
    };
    walk(controller.treeView());
    commands.push(
      { id: "edit:undo", label: this.words.text("shell.bar.undo"), group: "edit", shortcut: "Ctrl+Z", enabled: () => this.canHistoryStep("undo"), run: () => this.historyStep("undo") },
      { id: "edit:redo", label: this.words.text("shell.bar.redo"), group: "edit", shortcut: "Ctrl+Shift+Z", enabled: () => this.canHistoryStep("redo"), run: () => this.historyStep("redo") },
      { id: "edit:duplicate", label: this.words.text("shell.command.duplicate"), group: "edit", enabled: hasSelection, run: () => this.canvasEl.runAction("duplicate") },
      { id: "edit:move", label: this.words.text("canvas.action.move"), group: "edit", shortcut: "M", enabled: hasSelection, run: () => this.canvasEl.runAction("move") },
      { id: "edit:up", label: this.words.text("shell.command.up"), group: "edit", shortcut: "Alt+↑", enabled: hasSelection, run: () => this.canvasEl.runAction("up") },
      { id: "edit:down", label: this.words.text("shell.command.down"), group: "edit", shortcut: "Alt+↓", enabled: hasSelection, run: () => this.canvasEl.runAction("down") },
      ...(this.featureEnabled("logic")
        ? [{ id: "edit:logic", label: this.words.text("shell.command.logic"), group: "edit" as const, enabled: hasSelection, run: () => this.canvasEl.runAction("logic") }]
        : []),
      { id: "edit:delete", label: this.words.text("shell.command.delete"), group: "edit", shortcut: "Delete", enabled: hasSelection, run: () => this.canvasEl.runAction("delete") }
    );
    for (const mode of this.modeMap.values()) {
      const documents = mode.documents;
      if (!documents) {
        continue;
      }
      for (const document of documents.list()) {
        commands.push({
          id: `document:${mode.id}:${document.id}`,
          label: this.words.text("shell.command.open", { name: document.label }),
          group: "documents",
          keywords: [this.modeLabel(mode), document.id],
          run: () => {
            this.selectDocument(mode.id, document.id);
          }
        });
      }
      if (documents.add) {
        const kinds = documents.addKinds ?? [{ id: "", noun: this.modeLabel(mode).toLowerCase() }];
        for (const kind of kinds) {
          commands.push({
            id: `document:add:${mode.id}:${kind.id}`,
            label: this.words.text("shell.command.new", { noun: kind.noun }),
            group: "documents",
            keywords: [this.modeLabel(mode)],
            run: () => {
              this.addDocument(mode, kind.id || undefined);
            }
          });
        }
      }
    }
    for (const panel of SHELL_PANELS) {
      if (!panel.workspaces.includes(this.workspaceValue)) {
        continue;
      }
      const item = this.rootNode.querySelector<HTMLElement>(`[data-strip] [data-panel="${panel.id}"]`);
      if (!item || item.hidden) {
        continue;
      }
      commands.push({
        id: `view:${panel.id}`,
        label: this.words.text("shell.command.showPanel", { panel: panelLabel(panel, this.words) }),
        group: "view",
        keywords: [panelTitle(panel, this.words)],
        run: () => {
          this.autoPalette = false;
          this.setPanel(panel.id);
        }
      });
    }
    commands.push({
      id: "view:full-window",
      label: this.words.text(this.fullWindow ? "shell.bar.leaveFullWindow" : "shell.bar.fullWindow"),
      group: "view",
      keywords: ["maximize", "fullscreen", "expand"],
      enabled: () => this.fullWindow || !this.hasAttribute("no-full-window"),
      run: () => {
        this.fullWindow = !this.fullWindow;
      }
    });
    commands.push({
      id: "view:show-hidden",
      label: this.words.text(controller.showHiddenComponents() ? "shell.command.stopHidden" : "shell.command.showHidden"),
      group: "view",
      run: () => {
        const current = this.activeMode.controller;
        current.setShowHiddenComponents(!current.showHiddenComponents());
      }
    });
    // Try it on every canvas that has it, through the unsaved-edits guard as the bar's button.
    if (this.canvasTryable()) {
      commands.push({
        id: "view:try-it",
        label: this.words.text(this.canvasEl.previewing ? "shell.command.backToEditing" : this.textKey("shell.command.tryIt")),
        group: "view",
        run: () => this.toggleTryIt()
      });
    }
    if (this.workspaceValue === "form") {
      for (const [width, name] of [[1280, "desktop"], [768, "tablet"], [390, "phone"]] as const) {
        commands.push({ id: `view:width-${name}`, label: this.words.text(`shell.command.width.${name}`), group: "view", keywords: [String(width)], run: () => this.activeMode.controller.setPreviewWidth(width) });
      }
    }
    for (const source of this.commandSources) {
      try {
        commands.push(...source.commands().map((command) => ({ ...command, group: "host" as const })));
      } catch (error) {
        console.warn("datum-builder: a host's command source failed; its commands are left out.", error);
      }
    }
    return commands;
  }

  /** Whether a designer's workspace is showing its overview: the workspace on, no document's designer on the page. */
  private onOverview(): boolean {
    return isDesignerWorkspace(this.workspaceValue) && this.activeMode.id === PRIMARY_BUILDER_MODE;
  }

  /**
   * Puts the form back on the page from a designer. `toOverview`: the workspace stays a designer's,
   * on its overview ("‹ Layouts", the other designer's tab); otherwise reflectMode takes the form's
   * last workspace.
   */
  private bringFormBack(toOverview: boolean): void {
    this.returningToOverview = toOverview;
    void this.activateMode(this.modeMap.get(PRIMARY_BUILDER_MODE)!).finally(() => {
      this.returningToOverview = false;
    });
  }

  /**
   * The bar's "‹ Journeys" / "‹ Layouts", leading the document's pill: shown while a journey's or a
   * PDF layout's designer is on the page, worded for the overview it leads back to.
   */
  private syncOverviewBack(): void {
    const button = this.rootNode.querySelector<HTMLElement>("[data-overview-back]");
    if (!button) {
      return;
    }
    const workspace = this.workspaceValue;
    const shown = isDesignerWorkspace(workspace) && !this.onOverview();
    button.hidden = !shown;
    this.rootNode.querySelector<HTMLElement>("[data-overview-back-sep]")?.toggleAttribute("hidden", !shown || !this.showModeSwitchValue);
    if (shown) {
      const pdf = workspace === "pdf";
      button.textContent = this.words.text(pdf ? "canvas.backPdfText" : "canvas.backJourneysText");
      button.setAttribute("aria-label", this.words.text(pdf ? "canvas.backPdf" : "canvas.backJourneys"));
    }
  }

  /**
   * "‹ Journeys", "‹ Layouts", a phone's back title and the drawer's All journeys / All layouts:
   * the designer's overview, once its unsaved edits are dealt with (the prompt every other way
   * out of a designer asks), so no draft is left behind in a designer no longer on the page.
   */
  private backToOverview(): void {
    if (this.activeMode.id === PRIMARY_BUILDER_MODE) {
      return;
    }
    this.activeController.requestLeave(() => {
      if (this.activeMode.id !== PRIMARY_BUILDER_MODE) {
        this.bringFormBack(true);
      }
    });
  }

  /**
   * A switch still activating gives way to a choice made since: it lands nothing when its turn
   * comes, and its mode is taken down ({@link takeDownSuperseded}).
   */
  private supersedeActivation(): void {
    const superseded = this.activating;
    if (superseded === undefined) {
      return;
    }
    this.activating = undefined;
    this.modeToken += 1;
    this.setDocumentFaceBusy(false);
    this.takeDownSuperseded(superseded);
  }

  /**
   * Deactivates `mode`, whose switch gave way to another choice or failed: what its `activate`
   * set up (a designer hearing the form's edits as made on its page, its listener on the shell)
   * must not stay while another mode is on the page. Asked as soon as the switch gives way, and
   * again once its `activate` settles, for what it set up after that. The mode on the page, and
   * one a newer switch is activating again, are left as they are.
   */
  private takeDownSuperseded(mode: BuilderMode | undefined): void {
    if (mode !== undefined && mode !== this.activeMode && mode !== this.activating) {
      mode.deactivate?.();
    }
  }

  /**
   * Ends Try it at the start of a mode, document or workspace switch, so `data-trying`
   * and the form drawn in a designer's place never carry into what comes next.
   */
  private endTrying(): void {
    if (this.canvasEl?.previewing) {
      this.canvasEl.previewing = false;
    }
  }

  /**
   * Whether the canvas on the page can be tried: the Form workspace's, or a designer's
   * open document, unless the surface in the sheet's place has no Try it. Not an overview, Logic,
   * Data or Languages, which show no canvas.
   */
  private canvasTryable(): boolean {
    const workspace = this.workspaceValue;
    if (workspace !== "form" && (!isDesignerWorkspace(workspace) || this.activeMode.id === PRIMARY_BUILDER_MODE)) {
      return false;
    }
    return this.surfaces.get(this.activeMode) === undefined || this.surfaceOptions.get(this.activeMode)?.tryable === true;
  }

  /** The mode lending `tryIt.pdf` (the PDF designer), on the page or not: Try it's Preview PDF prints through it. */
  private pdfTryMode(): BuilderMode | undefined {
    for (const mode of this.modeMap.values()) {
      if (mode.tryIt?.pdf) {
        return mode;
      }
    }
    return undefined;
  }

  /** The definition's `pdf` block as a mode holds it, for the fallback Preview PDF on a page with no PDF mode. */
  private definitionPdf(): PdfConfiguration | undefined {
    for (const mode of this.modeMap.values()) {
      const pdf = mode.definitionPdf?.();
      if (pdf) {
        return pdf;
      }
    }
    return undefined;
  }

  /** A phone's sheets go with a workspace switch: the drawer, More, Try it and its results, and the inspector. */
  private putPhoneSheetsAway(): void {
    this.menuOpen = false;
    this.rootNode.querySelector<HTMLElement>("[data-menu-drawer]")?.toggleAttribute("hidden", true);
    this.moreOpen = false;
    this.rootNode.querySelector<HTMLElement>("[data-more-sheet]")?.toggleAttribute("hidden", true);
    if (this.resultsOpen) {
      this.resultsOpen = false;
      this.canvasEl?.removeAttribute("data-results-open");
    }
    if (this.canvasEl?.previewing) {
      this.canvasEl.previewing = false;
    }
    if (this.propertiesEl && !this.propertiesEl.collapsed) {
      this.foldInspector(true);
    }
  }

  /** Whether `element` is drawn as far as the markup says: connected, with no `hidden` on it or above it, through shadow roots. */
  private shownDeep(element: Element | undefined): boolean {
    let node: Element | undefined = element;
    if (!node?.isConnected) {
      return false;
    }
    while (node) {
      if (node.hasAttribute("hidden")) {
        return false;
      }
      const parent: Element | null = node.parentElement;
      if (parent) {
        node = parent;
      } else {
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : undefined;
      }
    }
    return true;
  }

  /** The element with focus inside the builder, when it is one the author can see. */
  private shownFocus(): HTMLElement | undefined {
    const active = this.deepActiveElement();
    return active && this.shownDeep(active) ? active : undefined;
  }

  /**
   * After a switch between an overview and a designer, focus that went down with
   * what the author pressed (a card's Open, "‹ Journeys", the back title, the last document's
   * Delete) lands somewhere drawn: the overview's card for the document just left, else its New;
   * a designer's canvas; otherwise the workspace's own control. Focus elsewhere is left alone.
   */
  private rescueFocus(left: { modeId: string; documentId: string | undefined } | undefined): void {
    if (!this.wrapEl || this.shownFocus()) {
      return;
    }
    if (this.onOverview()) {
      const documentId = left && workspaceForMode(left.modeId) === this.workspaceValue ? left.documentId : undefined;
      if (this.overviewEl) {
        this.overviewEl.focusCard(documentId);
      } else {
        this.pendingOverviewFocus = { documentId };
      }
      return;
    }
    const page = this.canvasEl?.shadowRoot?.querySelector<HTMLElement>(".canvas-page");
    if (this.workspaceValue === "form" || this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      if (page && this.shownDeep(page)) {
        page.focus({ preventScroll: true });
        return;
      }
    }
    const fallback = this.phone
      ? this.rootNode.querySelector<HTMLElement>("[data-menu-open]")
      : this.rootNode.querySelector<HTMLElement>(`[data-workspace-tab="${this.workspaceValue}"]`);
    fallback?.focus({ preventScroll: true });
  }

  /**
   * The Journeys and PDF overviews: shown while that workspace is on with no document
   * open, their chunk loaded the first time; a designer gets "‹ Journeys" or "‹ Layouts" back to
   * its overview on the canvas.
   */
  private syncOverview(): void {
    const host = this.rootNode?.querySelector<HTMLElement>("[data-overview-host]");
    if (!host) {
      return;
    }
    const workspace = this.workspaceValue;
    const overview = this.onOverview();
    host.hidden = !overview;
    // From an overview into a designer, the designer opens bare: no panel is chosen for the author.
    const wasDesigner = this.designerShown;
    this.designerShown = isDesignerWorkspace(workspace) && !overview;
    this.overviewShown = overview;
    // Back on the overview from a designer: its drawer is put away.
    if (overview && wasDesigner && this.activePanel !== undefined) {
      this.setPanel(undefined);
    }
    this.wrapEl?.toggleAttribute("data-overview", overview);
    this.syncOverviewBack();
    if (!overview || !isDesignerWorkspace(workspace)) {
      this.pendingOverviewFocus = undefined;
      return;
    }
    const section: OverviewSection = workspace;
    const modes = [...this.modeMap.keys()].filter((id) => id !== PRIMARY_BUILDER_MODE);
    if (this.overviewEl) {
      this.overviewEl.section = section;
      this.overviewEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      this.overviewEl.modes = modes;
      this.overviewEl.refresh();
      return;
    }
    if (this.overviewLoading) {
      return;
    }
    this.overviewLoading = true;
    const what = section === "pdf" ? "layouts" : "journeys";
    host.innerHTML = this.loadingCard(`shell.load.${what}`);
    const generation = this.domGeneration;
    loadOverviewSurface().then(
      (module) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.overviewLoading = false;
        try {
          const element = document.createElement(module.DATUM_BUILDER_OVERVIEW_TAG) as DatumBuilderOverviewElement;
          // It declares the token defaults on its own host: the theme goes on it too (themeTargets).
          this.paintThemeVars(element);
          element.section = isDesignerWorkspace(this.workspaceValue) ? this.workspaceValue : section;
          element.definition = () => this.logicDefinitionSource?.();
          element.modes = modes;
          element.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
          host.replaceChildren(element);
          this.overviewEl = element;
          this.applyPanelTexts();
          element.toggleAttribute("data-phone", this.phone);
          // Focus that went down with a designer waits for the overview's cards.
          const pending = this.pendingOverviewFocus;
          this.pendingOverviewFocus = undefined;
          if (pending && this.overviewShown && !this.shownFocus()) {
            element.focusCard(pending.documentId);
          }
        } catch (cause) {
          this.overviewEl = undefined;
          this.surfaceFailed(host, `shell.load.failed.${what}`, "data-overview-retry", cause);
        }
      },
      (cause: unknown) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.overviewLoading = false;
        this.surfaceFailed(host, `shell.load.failed.${what}`, "data-overview-retry", cause);
      }
    );
  }

  /**
   * Data's surface: shown while Data is on, its chunk loaded the first time, a card
   * with Retry when the load fails. It edits the form's controller through the selection's draft.
   */
  private syncData(): void {
    const host = this.rootNode?.querySelector<HTMLElement>("[data-data-host]");
    if (!host) {
      return;
    }
    const on = this.workspaceValue === "data";
    host.hidden = !on;
    if (!on) {
      return;
    }
    if (this.dataEl) {
      this.dataEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      return;
    }
    if (this.dataLoading) {
      return;
    }
    this.dataLoading = true;
    host.innerHTML = this.loadingCard("shell.load.data");
    const generation = this.domGeneration;
    loadDataSurface().then(
      (module) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.dataLoading = false;
        try {
          const element = document.createElement(module.DATUM_BUILDER_DATA_TAG) as DatumBuilderDataElement;
          // It declares the token defaults on its own host: the theme goes on it too (themeTargets).
          this.paintThemeVars(element);
          element.definition = () => this.logicDefinitionSource?.();
          element.importEnabled = featureOn(this.featuresValue, "data-model");
          element.jsonEnabled = featureOn(this.featuresValue, "json");
          element.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
          host.replaceChildren(element);
          this.dataEl = element;
          this.applyPanelTexts();
          element.toggleAttribute("data-phone", this.phone);
        } catch (cause) {
          this.dataEl = undefined;
          this.surfaceFailed(host, "shell.load.failed.data", "data-data-retry", cause);
        }
      },
      (cause: unknown) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.dataLoading = false;
        this.surfaceFailed(host, "shell.load.failed.data", "data-data-retry", cause);
      }
    );
  }

  /**
   * Languages' surface: shown while Languages is on, its chunk loaded the first time,
   * a card with Retry when the load fails. It edits the form's controller; the other modes' texts
   * (a journey's wording) are listed with it, read only, refreshed on every visit.
   */
  private syncLanguages(): void {
    const host = this.rootNode?.querySelector<HTMLElement>("[data-languages-host]");
    if (!host) {
      return;
    }
    const on = this.workspaceValue === "languages";
    host.hidden = !on;
    if (!on) {
      // A modal dialog the surface opened must not outlive its host's hiding (a workspace change
      // from code never goes through the inert UI): it would leave the page inert behind nothing.
      this.languagesEl?.closeExchange();
      // Hidden, the surface draws nothing: an edit made elsewhere is drawn when Languages is back.
      if (this.languagesEl) {
        this.languagesEl.shown = false;
      }
      // The next visit refreshes the table (feedLanguages).
      if (this.languagesFed) {
        this.languagesFed.visiting = false;
      }
      return;
    }
    if (this.languagesEl) {
      this.feedLanguages(this.languagesEl);
      this.languagesEl.shown = true;
      return;
    }
    if (this.languagesLoading) {
      return;
    }
    this.languagesLoading = true;
    host.innerHTML = this.loadingCard("shell.load.languages");
    const generation = this.domGeneration;
    loadLanguagesSurface().then(
      (module) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.languagesLoading = false;
        try {
          const element = document.createElement(module.DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
          // It declares the token defaults on its own host: the theme goes on it too (themeTargets).
          this.paintThemeVars(element);
          this.feedLanguages(element);
          // The workspace may have moved on while the chunk came: a surface connected hidden draws
          // nothing until syncLanguages shows it, and the next visit hands the modes' texts again.
          const visiting = this.workspaceValue === "languages";
          element.shown = visiting;
          if (!visiting && this.languagesFed) {
            this.languagesFed.visiting = false;
          }
          host.replaceChildren(element);
          this.languagesEl = element;
          this.applyPanelTexts();
          element.toggleAttribute("data-phone", this.phone);
          this.deliverLanguagesFocus();
        } catch (cause) {
          this.languagesEl = undefined;
          this.surfaceFailed(host, "shell.load.failed.languages", "data-languages-retry", cause);
        }
      },
      (cause: unknown) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.languagesLoading = false;
        this.surfaceFailed(host, "shell.load.failed.languages", "data-languages-retry", cause);
      }
    );
  }

  /**
   * Print's surface: shown while Print is on, its chunk loaded the first time, a card with Retry
   * when the load fails. It edits the form's controller; its samples are its own, never the form's.
   */
  private syncPrint(): void {
    const host = this.rootNode?.querySelector<HTMLElement>("[data-print-host]");
    if (!host) {
      return;
    }
    const on = this.workspaceValue === "print";
    host.hidden = !on;
    if (!on) {
      // Hidden, the surface draws nothing: an edit made elsewhere is drawn when Print is back.
      if (this.printEl) {
        this.printEl.shown = false;
      }
      return;
    }
    if (this.printEl) {
      this.feedPrint(this.printEl);
      this.printEl.shown = true;
      return;
    }
    if (this.printLoading) {
      return;
    }
    this.printLoading = true;
    host.innerHTML = this.loadingCard("shell.load.print");
    const generation = this.domGeneration;
    loadPrintSurface().then(
      (module) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.printLoading = false;
        try {
          const element = document.createElement(module.DATUM_BUILDER_PRINT_TAG) as DatumBuilderPrintElement;
          this.paintThemeVars(element);
          this.feedPrint(element);
          // The workspace may have moved on while the chunk came.
          element.shown = this.workspaceValue === "print";
          host.replaceChildren(element);
          this.printEl = element;
          this.applyPanelTexts();
          element.toggleAttribute("data-phone", this.phone);
        } catch (cause) {
          this.printEl = undefined;
          this.surfaceFailed(host, "shell.load.failed.print", "data-print-retry", cause);
        }
      },
      (cause: unknown) => {
        if (generation !== this.domGeneration) {
          return;
        }
        this.printLoading = false;
        this.surfaceFailed(host, "shell.load.failed.print", "data-print-retry", cause);
      }
    );
  }

  /** What Print draws from: the form's controller, the whole definition, the canvas's answers and renderer set-up, a journey's runtime. */
  private feedPrint(element: DatumBuilderPrintElement): void {
    element.definition = () => this.logicDefinitionSource?.();
    element.formulaFunctions = this.formulaFunctionsValue;
    element.testsEnabled = featureOn(this.featuresValue, "tests");
    element.printTheme = this.printThemeValue;
    element.historyStep = this.surfaceHistoryStep;
    element.sources = this.printSourcesValue ??= {
      tryAnswers: () => this.canvasEl?.previewRuntime()?.state().values,
      hasJourney: () => Array.isArray(this.journeysBlock()?.journeys) && (this.journeysBlock()!.journeys as unknown[]).length > 0,
      // A print's own session, never Try it's: the journey Try it runs in Journeys is left as it is.
      journeySession: (answers) => (this.opensAsJourney() ? this.modeMap.get(DESIGNER_WORKSPACES.journeys)?.printSession?.(answers) : undefined),
      configureRenderer: (renderer) => this.canvasEl?.configurePrintRenderer(renderer)
    };
    element.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
  }

  /** The definition's `journey` block as the modes hold it. */
  private journeysBlock(): { journeys?: unknown; opensAs?: unknown } | undefined {
    return [...this.modeMap.values()]
      .flatMap((mode) => mode.localeDocument?.() ?? [])
      .find((document) => document.id === "journeys")
      ?.read() as { journeys?: unknown; opensAs?: unknown } | undefined;
  }

  /** Whether the form opens as a journey (it has one, and does not open as a form). */
  private opensAsJourney(): boolean {
    const block = this.journeysBlock();
    return Array.isArray(block?.journeys) && block.journeys.length > 0 && block.opensAs !== "form";
  }

  /**
   * The print theme the canvas's renderer and the Print workspace draw a print with (the page's
   * own, as `<datum-form>` takes it); unset, the basic one.
   */
  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
    if (this.canvasEl) {
      this.canvasEl.printTheme = value;
    }
    if (this.printEl) {
      this.printEl.printTheme = value;
    }
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  /** The catalog the host's translations source answers now, if it has one and it answers. */
  private hostCatalogData(): TranslationCatalog | undefined {
    // Asked once per tick: the inspector's model is built several times a paint, the host's answer need not be.
    if (this.hostCatalogTick) {
      return this.hostCatalogTick.catalog;
    }
    let catalog: TranslationCatalog | undefined;
    try {
      catalog = this.translationsSourceValue?.().catalog;
    } catch {
      catalog = undefined;
    }
    this.hostCatalogTick = { catalog };
    queueMicrotask(() => {
      this.hostCatalogTick = undefined;
    });
    return catalog;
  }
  private hostCatalogTick: { catalog: TranslationCatalog | undefined } | undefined;

  /**
   * What Languages draws from: the form's controller, the bar's language, the other modes' texts. The
   * host's catalog is read live from the controller, never copied here, so a source the page swaps
   * takes effect at once.
   *
   * Every setter on the surface repaints its table, and this runs on each `applyWorkspace` while
   * Languages is open (a mode registering, a strip item slotting): handing all six over each time
   * rebuilt the table six times under an author's caret or IME composition. The sources are fixed
   * closures given once, and after that only what changed is set: the flag and the language when they
   * differ from the surface's own, the modes' texts (one repaint) on a visit or when the set of
   * registered modes changed. Edits to the texts themselves reach the surface through the controller.
   */
  private feedLanguages(element: DatumBuilderLanguagesElement): void {
    const controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
    const modes = [...this.modeMap.keys()].join("\u0000");
    const fed = this.languagesFed?.element === element ? this.languagesFed : undefined;
    this.languagesFed = { element, modes, visiting: true };
    const hostCatalog = this.translationsSourceValue !== undefined;
    element.historyStep = this.surfaceHistoryStep;
    if (!fed) {
      element.definition = this.languagesDefinition;
      element.hostCatalog = hostCatalog;
      element.extraTexts = this.languagesExtraTextsSource;
      element.pdfTexts = this.languagesPdfTextsSource;
      element.locale = controller.currentLocale();
      element.controller = controller;
      return;
    }
    if (element.hostCatalog !== hostCatalog) {
      element.hostCatalog = hostCatalog;
    }
    if (element.locale !== controller.currentLocale()) {
      element.locale = controller.currentLocale();
    }
    if (!fed.visiting || fed.modes !== modes) {
      element.extraTexts = this.languagesExtraTextsSource;
    }
    element.controller = controller;
  }

  private languagesFed: { element: DatumBuilderLanguagesElement; modes: string; visiting: boolean } | undefined;
  private readonly languagesDefinition = (): FormDefinition | undefined => this.logicDefinitionSource?.();
  // Asked again at every paint: Apply writes the modes' documents and the table redraws from them.
  private readonly languagesExtraTextsSource = (words: BuilderTextOptions): TranslatableText[] => this.languagesExtraTexts(words);
  private readonly languagesPdfTextsSource = (words: BuilderTextOptions): TranslatableText[] => this.languagesPdfTexts(words);

  /** The other modes' texts Languages lists under Journeys (`BuilderMode.translatableTexts`). */
  private languagesExtraTexts(words: BuilderTextOptions): TranslatableText[] {
    return [...this.modeMap.values()].flatMap((mode) => (mode.id !== PRIMARY_BUILDER_MODE && mode.translatableTexts ? mode.translatableTexts?.(words) ?? [] : []));
  }

  /** The modes' texts Languages lists under PDF (`BuilderMode.languageTexts`). */
  private languagesPdfTexts(words: BuilderTextOptions): TranslatableText[] {
    return [...this.modeMap.values()].flatMap((mode) => mode.languageTexts?.(words) ?? []);
  }

  /**
   * The plugin functions the host wired (`pluginPlatform.formulaFunctions`, a `FormulaFunctionRegistry`,
   * or anything with its `table()` and `signatures()`). The builder holds no plugin platform of
   * its own, so the host hands the registry over; the Logic editor, the inspector, the Form
   * panel and the Variables panel then list these functions with the built-ins and the parser
   * accepts them. Unset: the built-ins only.
   */
  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    this.formulaFunctionsValue = value;
    this.applyFormulaFunctions();
  }

  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.formulaFunctionsValue;
  }

  /** Where the "Formula reference" links go; unset: no link is drawn anywhere (the builder has no page of its own to name). */
  public set formulaReferenceHref(value: string | undefined) {
    this.formulaReferenceHrefValue = value;
    this.applyFormulaFunctions();
  }

  public get formulaReferenceHref(): string | undefined {
    return this.formulaReferenceHrefValue;
  }

  /** The builder's own language for its words (the text catalog's locale), not the form's. Reaches the Logic surface. */
  public set textLocale(value: string | undefined) {
    // The same locale again changes no word: the shell's texts are not written a second time (a mount sets it once, to the default).
    if (value === this.textLocaleValue) {
      return;
    }
    this.textLocaleValue = value;
    this.words.locale = value;
    this.syncControllerWords();
    this.applyFormulaFunctions();
    this.applyShellTexts();
  }

  public get textLocale(): string | undefined {
    return this.textLocaleValue;
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. Reaches the Logic surface. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    // No catalog over no catalog changes no word. The same object again is applied again: a host may have added keys to it.
    if (value === undefined && this.textCatalogValue === undefined) {
      return;
    }
    this.textCatalogValue = value;
    this.words.catalog = value;
    this.syncControllerWords();
    this.applyFormulaFunctions();
    this.applyShellTexts();
  }

  public get textCatalog(): BuilderTextCatalog | undefined {
    return this.textCatalogValue;
  }

  /**
   * The builder's words for the shell chrome (the strip, the View and Settings panels, the
   * rail), applied in place: the strip items' names and tooltips, then every element of the
   * wrapper's markup that carries a `data-t` key (its text) or `data-t-attr` (`attr:key;...`).
   * No canvas repaint; the panels and surfaces take the catalog through {@link applyPanelTexts}.
   */
  private applyShellTexts(): void {
    const root = this.rootNode;
    if (!root) {
      return;
    }
    for (const panel of SHELL_PANELS) {
      const item = root.querySelector<HTMLElement>(`[data-strip] [data-panel="${panel.id}"]`);
      if (!item) {
        continue;
      }
      item.setAttribute("data-tip", panelTitle(panel, this.words));
      item.setAttribute("aria-label", panelLabel(panel, this.words));
      const caption = item.querySelector<HTMLElement>(".strip-label");
      if (caption) {
        caption.textContent = panelShort(panel, this.words);
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-t]")) {
      element.textContent = this.words.text(this.textKey(element.dataset.t as BuilderTextKey));
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-t-attr]")) {
      for (const pair of (element.dataset.tAttr ?? "").split(";")) {
        const [name, key] = pair.split(":");
        if (name && key) {
          element.setAttribute(name, this.words.text(key as BuilderTextKey));
        }
      }
    }
    this.applyPanelTexts();
    this.syncOverviewBack();
    // The loop above reset the Tests item's name to its label: its count goes back into it.
    this.applyTestsCount();
    // The handle's name is the catalog's too (set by the sheet sync, not by a data-t key).
    if (this.phone) {
      this.syncSheets();
    }
    // The rail follows the words too, once there is a mode to list the types of.
    if (this.modeMap.size > 0) {
      this.renderAddRail();
    }
    if (this.ctrl) {
      // The sources list and the width and theme tooltips are built from the controller's state.
      this.sourcesSignature = undefined;
      this.syncBar();
      this.placeModeActions();
      // What the code (not a data-t key) writes: the tabs' problem names, the file menu, the full-window button, the document label, the drawer.
      this.applyWorkspaceCounts();
      this.syncFileActions();
      this.syncSaveCue();
      this.syncFullWindow();
      this.renderDocuments();
      this.syncTopRow();
      if (this.menuOpen) {
        this.renderMenu();
      }
    }
  }

  /** The form's controller words its own messages (class-name checks, catalog row labels) in the builder's locale and catalog. */
  private syncControllerWords(): void {
    this.ctrl?.setTextWords({ locale: this.textLocaleValue, catalog: () => this.textCatalogValue });
  }

  /** Hands the builder's locale and catalog to the panels and surfaces that draw their own words. */
  private applyPanelTexts(): void {
    const locale = this.textLocaleValue;
    const catalog = this.textCatalogValue;
    for (const element of [this.outlineEl, this.fieldsEl, this.toolbarEl, this.variablesPanelEl, this.testsPanelEl, this.chromePanelEl, this.dataEl, this.languagesEl, this.printEl, this.overviewEl, this.paletteEl, this.canvasEl]) {
      if (element) {
        element.textLocale = locale;
        element.textCatalog = catalog;
      }
    }
  }

  /** Hands the wired functions and the reference link to every panel that writes or lists formulas. */
  private applyFormulaFunctions(): void {
    const source = this.formulaFunctionsValue;
    if (this.canvasEl) {
      // The canvas preview parses and evaluates a rule calling a plugin function.
      this.canvasEl.formulaFunctions = source;
    }
    for (const mode of this.modeMap.values()) {
      // A mode that previews answers itself (the PDF designer's field previews) takes them too.
      mode.formulaFunctions = source;
    }
    if (this.logicEl) {
      this.logicEl.formulaFunctions = source;
      this.logicEl.referenceHref = this.formulaReferenceHrefValue;
      this.logicEl.locale = this.textLocaleValue;
      this.logicEl.catalog = this.textCatalogValue;
    }
    if (this.propertiesEl) {
      this.propertiesEl.formulaFunctions = source;
      this.propertiesEl.formulaReferenceHref = this.formulaReferenceHrefValue;
      this.propertiesEl.textLocale = this.textLocaleValue;
      this.propertiesEl.textCatalog = this.textCatalogValue;
    }
    if (this.formSettingsEl) {
      this.formSettingsEl.formulaFunctions = source;
      this.formSettingsEl.formulaReferenceHref = this.formulaReferenceHrefValue;
      this.formSettingsEl.textLocale = this.textLocaleValue;
      this.formSettingsEl.textCatalog = this.textCatalogValue;
    }
    if (this.variablesPanelEl) {
      this.feedVariablesFunctions(this.variablesPanelEl);
    }
    // The Tests panel parses and runs scenarios with the plugin functions a host wired.
    if (this.testsPanelEl) {
      this.testsPanelEl.formulaFunctions = source;
    }
    if (this.printEl) {
      this.printEl.formulaFunctions = source;
    }
  }

  /** The Variables panel's share of {@link applyFormulaFunctions}: the functions it lists, the reference link, its words. */
  private feedVariablesFunctions(panel: DatumBuilderVariablesPanelElement): void {
    panel.functions = formulaFunctionRows(this.formulaFunctionsValue).map((row) => ({
      name: row.name,
      params: row.params,
      ...(row.variadic ? { variadic: true } : {}),
      group: row.group,
      summary: row.summary
    }));
    panel.referenceHref = this.formulaReferenceHrefValue;
    panel.textLocale = this.textLocaleValue;
    panel.textCatalog = this.textCatalogValue;
  }

  /**
   * The whole definition, journeys and PDF layouts included, for the rules Logic lists
   * read-only. `<datum-form-builder>` sets it; without it Logic lists the form's rules alone.
   */
  public set logicDefinition(source: (() => FormDefinition | undefined) | undefined) {
    this.logicDefinitionSource = source;
    if (this.logicEl) {
      this.logicEl.definition = () => this.logicDefinitionSource?.();
    }
    if (this.dataEl) {
      this.dataEl.definition = () => this.logicDefinitionSource?.();
    }
    if (this.languagesEl) {
      this.languagesEl.definition = () => this.logicDefinitionSource?.();
    }
    if (this.printEl) {
      this.printEl.definition = () => this.logicDefinitionSource?.();
    }
  }

  /**
   * The component rail (the left rail): up to {@link RAIL_SIZE} of the
   * types the form offers, in {@link RAIL_ORDER}, then All components. Form on the form only;
   * a PDF layout or a journey has its own palette.
   */
  private renderAddRail(): void {
    const rail = this.rootNode?.querySelector<HTMLElement>("[data-add-rail]");
    if (!rail) {
      return;
    }
    const show = this.workspaceValue === "form" && this.activeMode.id === PRIMARY_BUILDER_MODE;
    rail.hidden = !show;
    if (!show) {
      return;
    }
    const types = this.activeMode.controller.componentTypes();
    // All components opens the palette panel: without that panel (`hidden-panels`) there is nothing to open.
    const allComponents = !this.panelOff("components");
    const picked = RAIL_ORDER.map((type) => types.find((entry) => entry.type === type)).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined
    );
    const shown = (picked.length > 0 ? picked : types).slice(0, RAIL_SIZE);
    const icons = this.iconSet();
    const markup =
      shown
        .map(
          (entry, rank) =>
            `<button type="button" class="strip-btn rail-btn" data-rail-add="${escapeHtml(entry.type)}" data-rail-rank="${rank}" draggable="true" aria-label="${escapeHtml(this.words.text("shell.rail.add", { type: entry.label }))}" data-tip="${escapeHtml(this.words.text("shell.rail.addTitle", { type: entry.label }))}" data-tip-side="end" tabindex="-1">${paletteIconHtml(entry, icons)}</button>`
        )
        .join("") +
      (!allComponents
        ? ""
        : `<button type="button" class="strip-btn rail-btn rail-more" data-rail-more aria-label="${escapeHtml(this.words.text("shell.rail.all"))}" data-tip="${escapeHtml(this.words.text("shell.rail.all"))}" data-tip-side="end" aria-pressed="${this.activePanel === "components"}" tabindex="-1"><span class="glyph"><svg class="rail-more-dots" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg><svg class="rail-more-plus" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"></path></svg></span><span class="strip-label" aria-hidden="true">${escapeHtml(this.words.text("shell.rail.allShort"))}</span></button>`);
    if (rail.dataset.markup !== markup) {
      rail.innerHTML = markup;
      rail.dataset.markup = markup;
    }
    // One Tab stop: the button last used, else the first.
    const buttons = [...rail.querySelectorAll<HTMLElement>("button")];
    if (!buttons.some((button) => button.tabIndex === 0)) {
      buttons[0]?.setAttribute("tabindex", "0");
    }
  }

  /** A rail button's click: the type added after the selection (or at the end), or the palette. */
  private onRailClick(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rail-add], [data-rail-more]");
    if (!button) {
      return;
    }
    this.roveRail(button);
    if (button.dataset.railMore !== undefined) {
      // A toggle, as the strip's items are: a second press puts the palette away.
      this.switchPanel(this.activePanel === "components" ? undefined : "components");
      return;
    }
    const controller = this.activeMode.controller;
    const selected = controller.selectedComponentId();
    controller.requestAddAfter(button.dataset.railAdd!, selected !== undefined && selected !== controller.rootId() ? selected : undefined);
  }

  /**
   * A rail button dragged: the same drag the palette's rows start, so a type can be dropped where
   * it belongs instead of added after the selection. The rail shows the palette's glyphs, and an
   * author who has dragged from the palette expects the rail to drag too.
   */
  private onRailDragStart(event: DragEvent): void {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rail-add]");
    const type = button?.dataset.railAdd;
    const dt = event.dataTransfer;
    if (!button || !type || !dt) {
      return;
    }
    writeDragPayload(dt, this.activeMode.controller.dragPayloadForType(type));
    if (typeof dt.setDragImage === "function") {
      dt.setDragImage(button, 12, 12);
    }
  }

  private onRailKey(event: KeyboardEvent): void {
    const rail = event.currentTarget as HTMLElement;
    const buttons = [...rail.querySelectorAll<HTMLElement>("button")].filter((button) => getComputedStyle(button).display !== "none");
    const at = buttons.indexOf(event.target as HTMLElement);
    const next =
      event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
    if (next === undefined || at < 0) {
      return;
    }
    event.preventDefault();
    const target = buttons[(next + buttons.length) % buttons.length]!;
    this.roveRail(target);
    target.focus();
  }

  private roveRail(stop: HTMLElement): void {
    for (const button of this.rootNode.querySelectorAll<HTMLElement>("[data-add-rail] button")) {
      button.setAttribute("tabindex", button === stop ? "0" : "-1");
    }
  }

  private applyWorkspace(): void {
    if (!this.wrapEl) {
      return;
    }
    const id = this.workspaceValue;
    this.wrapEl.dataset.workspace = id;
    const available = this.availableWorkspaces();
    for (const tab of this.rootNode.querySelectorAll<HTMLElement>("[data-workspace-tab]")) {
      const tabId = tab.dataset.workspaceTab as BuilderWorkspace;
      // A workspace the host has taken away is never drawn as the one the author is in.
      const current = tabId === id && available.includes(tabId);
      tab.hidden = !available.includes(tabId);
      tab.setAttribute("aria-selected", String(current));
      tab.tabIndex = current ? 0 : -1;
    }
    const menu = this.rootNode.querySelector<HTMLSelectElement>("[data-workspace-menu]");
    if (menu) {
      for (const option of menu.options) {
        option.hidden = !available.includes(option.value as BuilderWorkspace);
        option.disabled = option.hidden;
      }
      menu.value = id;
    }
    // One workspace, or none to choose between: no switch at all.
    const nav = this.rootNode.querySelector<HTMLElement>("[data-workspaces-nav]");
    if (nav) {
      nav.hidden = available.length < 2;
    }
    this.renderAddRail();
    this.syncLogic();
    this.syncData();
    this.syncLanguages();
    this.syncPrint();
    this.syncOverview();
    if (this.propertiesEl) {
      // The surfaces in the canvas's place draw the inspector's prompt themselves.
      this.propertiesEl.promptsElsewhere = id === "logic" || id === "data" || id === "languages" || id === "print" || this.onOverview();
    }
    for (const panel of [this.propertiesEl, this.formSettingsEl, this.chromePanelEl]) {
      if (panel) {
        panel.languagesWorkspace = available.includes("languages");
      }
    }
    for (const item of [...this.rootNode.querySelectorAll<HTMLElement>("[data-strip] [data-panel]"), ...this.hostStripItems()]) {
      const owners = (item.dataset.workspaces ?? item.dataset.workspace ?? "").split(/\s+/).filter(Boolean);
      item.toggleAttribute("data-out-of-workspace", owners.length > 0 && !owners.includes(id));
    }
    this.applyWorkspaceCounts();
    this.syncPhone();
  }

  private reflectWorkspace(): void {
    if (this.getAttribute("workspace") !== this.workspaceValue) {
      this.setAttribute("workspace", this.workspaceValue);
    }
    // The Variables panel lists what the workspace is about.
    if (this.variablesPanelEl) {
      this.variablesPanelEl.workspace = this.workspaceValue;
      // Print's slots read placeholders, the form's other workspaces rules.
      this.variablesPanelEl.syntax = this.workspaceValue === "print" ? "placeholders" : undefined;
    }
  }

  /** The controller behind the panels right now: the form's, or the active mode's (its selected document's). */
  public get activeController(): BuilderController {
    return this.activeMode.controller;
  }

  /** Whether the bar shows the document tabs. Default `true`; off, the page is switched through the API alone. */
  public get showModeSwitch(): boolean {
    return this.showModeSwitchValue;
  }

  public set showModeSwitch(value: boolean) {
    this.showModeSwitchValue = value;
    this.renderDocuments();
    if (this.documentsEl) {
      this.syncOverviewBack();
    }
  }

  /**
   * Modes whose tabs the bar leaves out — `["form"]` for a shell that edits only a mode's
   * documents (the standalone PDF designer). The mode stays registered and reachable by API.
   */
  public get hiddenModeIds(): string[] {
    return [...this.hiddenModes];
  }

  public set hiddenModeIds(value: string[]) {
    this.hiddenModes.clear();
    for (const id of value) {
      this.hiddenModes.add(id);
    }
    this.renderDocuments();
  }

  /**
   * Whether the builder covers the whole browser window, over the page it is
   * embedded in; reflects the `full-window` attribute. The bar's button toggles it unless the
   * host sets `no-full-window`; leaving full window puts the builder back in its place.
   */
  public get fullWindow(): boolean {
    return this.hasAttribute("full-window");
  }

  public set fullWindow(value: boolean) {
    this.toggleAttribute("full-window", value);
  }

  /**
   * The builder's own colour scheme: `"dark"` lays the studio look's dark palette
   * ({@link DATUM_DARK_BUILDER_THEME}) over a host `theme` (its colours win, the host's type,
   * space and radii stay) on the shell and every panel; `"light"` is the host's theme or the
   * built-in look. Reflects the `scheme` attribute; without one, the remembered choice, else a
   * host `theme` that is the dark builder theme (`datum-dark`) as the dark scheme. The ⋮ menu's Dark mode switch (and
   * the drawer's) changes it and remembers the choice for this origin, which a connect, or a
   * removal of the attribute, reads back; a page that sets the attribute decides for itself.
   * `no-scheme-toggle` takes the switch off the menus.
   */
  public get scheme(): BuilderScheme {
    const value = this.getAttribute("scheme");
    if (value === null) {
      // No attribute: the author's remembered choice, else the host theme's own (the dark builder
      // theme is the dark scheme, but only as the default, never over what the person chose).
      return this.rememberedScheme ?? (this.themeState?.id === DATUM_DARK_BUILDER_THEME.id ? "dark" : "light");
    }
    return value === "dark" ? "dark" : "light";
  }

  /** The remembered choice as read at connect (or when the attribute was removed); never read live. */
  private rememberedScheme: BuilderScheme | undefined;

  public set scheme(value: BuilderScheme) {
    this.setAttribute("scheme", value === "dark" ? "dark" : "light");
  }

  private schemeToggleOffered(): boolean {
    return !this.hasAttribute("no-scheme-toggle");
  }

  /**
   * The vars the shell writes: while dark, the dark palette over the host's theme (its type,
   * space and radii survive, every colour is the dark one); else the host's theme, else
   * (undefined) the built-in light look. A host theme that is the dark builder theme has the
   * built-in look as its light half.
   */
  private themeVars(): Record<string, string> | undefined {
    const host = this.themeState?.id === DATUM_DARK_BUILDER_THEME.id ? undefined : this.themeState;
    if (this.scheme === "dark") {
      return { ...(host ? buildThemeStyleVars(host) : {}), ...buildThemeStyleVars(DATUM_DARK_BUILDER_THEME) };
    }
    return host ? buildThemeStyleVars(host) : undefined;
  }

  /** The scheme `builder-scheme-change` last reported; `undefined` before the shell is up. */
  private schemeAnnounced: BuilderScheme | undefined;

  /** The tokens, the menus' switches and the event, after `scheme` or `no-scheme-toggle` changes. */
  private syncScheme(): void {
    if (!this.wrapEl) {
      return;
    }
    this.applyTheme();
    this.syncFileActions();
    if (this.menuOpen) {
      this.renderMenu();
    }
    const scheme = this.scheme;
    if (this.schemeAnnounced !== undefined && this.schemeAnnounced !== scheme) {
      this.schemeAnnounced = scheme;
      this.dispatchEvent(new CustomEvent<{ scheme: BuilderScheme }>("builder-scheme-change", { detail: { scheme }, bubbles: true, composed: true }));
    }
  }

  /** Dark mode from a menu: the other scheme, remembered for this origin. */
  private toggleScheme(): void {
    const next: BuilderScheme = this.scheme === "dark" ? "light" : "dark";
    writeSchemeMemory(next);
    this.rememberedScheme = next;
    this.scheme = next;
  }

  /** The side panel Try it put away, to open again on Back to editing. */
  private panelBeforeTrying: DatumBuilderPanel | undefined;

  /** The window's own scroll, held while the builder covers it, given back when it leaves. */
  private heldDocumentOverflow: string | undefined;
  /** The state `builder-full-window-change` last reported; `undefined` before the first sync. */
  private fullWindowAnnounced: boolean | undefined;

  /** The bar's button, the window's scroll and the event, after `full-window` changes. */
  private syncFullWindow(): void {
    const on = this.fullWindow;
    const button = this.rootNode?.querySelector<HTMLButtonElement>("[data-full-window]");
    if (button) {
      button.hidden = this.hasAttribute("no-full-window") && !on;
      button.setAttribute("aria-pressed", String(on));
      const label = this.words.text(on ? "shell.bar.leaveFullWindow" : "shell.bar.fullWindow");
      button.setAttribute("aria-label", label);
      button.dataset.tip = label;
      button.innerHTML = fullWindowGlyph(on);
    }
    this.syncDocumentLock();
    if (on !== (this.fullWindowAnnounced ?? false)) {
      this.dispatchEvent(new CustomEvent<{ fullWindow: boolean }>("builder-full-window-change", { detail: { fullWindow: on }, bubbles: true, composed: true }));
    }
    this.fullWindowAnnounced = on;
  }

  /**
   * The page under the builder must not scroll behind it: in full window (a wheel at the end of
   * a panel's scroll), and under a phone's sheet in the contained layout (a swipe that misses
   * the sheet), where the page is a host's and scrolls. The page layout is
   * the page, so it never scrolls under its own sheet.
   */
  private syncDocumentLock(): void {
    const want = this.isConnected && (this.fullWindow || (this.isContained() && this.phone && this.sheetKind !== undefined));
    const held = this.heldDocumentOverflow !== undefined;
    if (want && !held) {
      this.heldDocumentOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
    } else if (!want && held) {
      document.documentElement.style.overflow = this.heldDocumentOverflow ?? "";
      this.heldDocumentOverflow = undefined;
    }
  }

  /** See {@link DatumBuilderLayout}. Reflects the `layout` attribute; anything but `"contained"` is the page layout. */
  public get layout(): DatumBuilderLayout {
    return this.getAttribute("layout") === "contained" ? "contained" : "page";
  }

  public set layout(value: DatumBuilderLayout) {
    if (value === "contained") {
      this.setAttribute("layout", "contained");
    } else {
      this.removeAttribute("layout");
    }
  }

  /** The panel the activity strip has open beside the canvas; `undefined` while the side column is put away. */
  public get panel(): DatumBuilderPanel | undefined {
    return this.activePanel;
  }

  public set panel(value: DatumBuilderPanel | undefined) {
    // A shell panel the workspace on the page does not offer brings a form workspace
    // that does. The move asks the leave guard like any other: Languages holds typed cells and Logic
    // an open rule, which a bare move would hide with their prompt still to come. A Stay leaves the
    // panel as it was. The palette's strip item is the designers' alone, but Form opens it from the
    // rail.
    const open = (): void => {
      // A host naming the panel has chosen it.
      this.autoPalette = false;
      this.setPanel(value);
    };
    const target = this.wrapEl ? this.panelWorkspaceTarget(value) : undefined;
    if (target) {
      this.activeController.requestLeave(() => {
        this.enterWorkspace(target, { fromMode: true });
        open();
      });
      return;
    }
    open();
  }

  /**
   * The form workspace opening this panel would move the page to, or `undefined` when the panel
   * opens where the author is (the workspace owns it, or a designer is on the page). The move
   * asks the leave guard, so a caller that must not raise the author's prompt (the assistant's
   * open tool) asks this first.
   */
  public panelWorkspaceTarget(value: DatumBuilderPanel | undefined): BuilderWorkspace | undefined {
    const owners: readonly BuilderWorkspace[] | undefined = value === "components" ? ["form", "journeys", "pdf"] : SHELL_PANELS.find((entry) => entry.id === value)?.workspaces;
    if (!owners || owners.includes(this.workspaceValue) || isDesignerWorkspace(this.workspaceValue)) {
      return undefined;
    }
    return owners.find((id) => !isDesignerWorkspace(id) && this.availableWorkspaces().includes(id));
  }

  /**
   * The key the shell remembers its panels under: the strip's open panel, the two
   * column widths and whether the inspector is folded, kept in the page's storage and put
   * back when a shell with the same key next connects. `undefined` (the default) remembers
   * nothing. Reflects `persist-panels`; an empty value means the key `default`.
   */
  public get persistPanels(): string | undefined {
    return this.persistKey;
  }

  public set persistPanels(value: string | undefined) {
    if (value === undefined) {
      this.removeAttribute("persist-panels");
    } else if (this.getAttribute("persist-panels") !== value) {
      this.setAttribute("persist-panels", value);
    }
  }

  /** Whether the shell is narrow: under 900px the side column and the inspector open as drawers over the canvas. */
  public get narrowLayout(): boolean {
    return this.narrow;
  }

  public set options(value: DatumBuilderOptions) {
    this.optionsState = { ...this.optionsState, ...value };
    this.ctrl.setOptions(this.optionsState);
    if (this.wrapEl) {
      this.applyPanelControllers();
      this.paintIcons();
    }
    // A form put in place (the host's definition, File > Open or New all arrive here with an
    // initial root) settles the palette. Not read off the controller's "init": that
    // is also emitted for a definitions-only rebuild (a plugin registering late), which must
    // not move a palette under the author.
    if (value.initialRoot !== undefined) {
      this.settlePalette();
    }
  }

  public get options(): DatumBuilderOptions {
    return this.optionsState;
  }

  /** The icon set the shell and its panels draw with right now. */
  private iconSet(): IconSet {
    return this.optionsState.icons ?? defaultIconSet();
  }

  /** Redraws the shell's own glyphs from the current set, and writes the set's CSS beside them. */
  private paintIcons(): void {
    const icons = this.iconSet();
    for (const name of SHELL_GLYPHS) {
      for (const slot of this.rootNode.querySelectorAll<HTMLElement>(`[data-glyph="${name}"]`)) {
        slot.innerHTML = renderIcon(icons, name);
      }
    }
    const style = this.rootNode.querySelector<HTMLStyleElement>("style[data-icon-css]");
    if (style) {
      style.textContent = icons.css ?? "";
    }
    this.syncBar();
  }

  /**
   * See {@link DatumBuilderOptions.icons}. Set here rather than through `options`, a new set
   * repaints the chrome without re-applying the other options (and the tree they seed).
   */
  public set icons(value: IconSet | undefined) {
    this.optionsState = { ...this.optionsState, icons: value };
    if (this.wrapEl) {
      this.applyPanelIcons();
      this.paintIcons();
    }
  }

  public get icons(): IconSet | undefined {
    return this.optionsState.icons;
  }

  /** Hands the shell's icon set to its panels, whichever mode is on the page. */
  private applyPanelIcons(): void {
    const icons = this.optionsState.icons;
    this.toolbarEl.icons = icons;
    this.outlineEl.icons = icons;
    this.fieldsEl.icons = icons;
    this.canvasEl.icons = icons;
    this.propertiesEl.icons = icons;
    this.formSettingsEl.icons = icons;
    if (this.chromePanelEl) {
      this.chromePanelEl.icons = icons;
    }
    if (this.variablesPanelEl) {
      this.variablesPanelEl.icons = icons;
    }
    if (this.testsPanelEl) {
      this.testsPanelEl.icons = icons;
    }
  }

  /**
   * Applies a builder theme's tokens as `--db-*` CSS custom properties on the wrapper and its
   * panels (see {@link buildThemeStyleVars}). Set to `undefined` to revert to each panel's
   * built-in defaults.
   */
  public set theme(value: BuilderThemeDefinition | undefined) {
    const scheme = this.scheme;
    this.themeState = value;
    if (this.wrapEl) {
      this.applyTheme();
      // The dark builder theme is the dark scheme: the menus' switch follows it. The
      // host chose the theme, so no builder-scheme-change; the next toggle is measured from here.
      if (this.scheme !== scheme) {
        this.syncFileActions();
        if (this.menuOpen) {
          this.renderMenu();
        }
        if (this.schemeAnnounced !== undefined) {
          this.schemeAnnounced = this.scheme;
        }
      }
    }
  }

  public get theme(): BuilderThemeDefinition | undefined {
    return this.themeState;
  }

  /**
   * One of what the canvas previews with (the binding, its assets, the data sources), kept with
   * the rest of {@link options} and handed to the controller on its own. Not through `options`:
   * that re-applies every option given so far, `initialRoot` and `localization` among them, which
   * would put the form back as it was loaded and take the author's edits and their history with it.
   */
  private setPreviewOption<K extends "binding" | "assets" | "dataSourceResolver" | "dataSources">(key: K, value: DatumBuilderOptions[K]): void {
    this.optionsState = { ...this.optionsState, [key]: value };
    this.ctrl.setOptions({ [key]: value } as Pick<DatumBuilderOptions, K>);
    if (this.wrapEl) {
      this.applyPanelControllers();
    }
  }

  /**
   * The design-system binding the canvas draws the form with (see
   * {@link DatumBuilderOptions.binding}): a binding, a registered id, or nothing for Datum's.
   */
  public set binding(value: LiveBinding | string | undefined) {
    this.setPreviewOption("binding", value);
  }

  public get binding(): LiveBinding | string | undefined {
    return this.optionsState.binding;
  }

  /** The design system's files the canvas draws with (see {@link DatumBuilderOptions.assets}). */
  public set assets(value: LiveAssets | undefined) {
    this.setPreviewOption("assets", value);
  }

  public get assets(): LiveAssets | undefined {
    return this.optionsState.assets;
  }

  /** Resolves `select` options in the canvas preview. */
  public set dataSourceResolver(value: DataSourceResolver | undefined) {
    this.setPreviewOption("dataSourceResolver", value);
  }

  public get dataSourceResolver(): DataSourceResolver | undefined {
    return this.optionsState.dataSourceResolver;
  }

  /** The host's wiring-time data sources — the same set it hands the renderer. */
  public set dataSources(value: DataSourceSet | undefined) {
    this.setPreviewOption("dataSources", value);
  }

  public get dataSources(): DataSourceSet | undefined {
    return this.optionsState.dataSources;
  }

  public get value(): ComponentNode {
    return this.ctrl.snapshot();
  }

  /**
   * The committed `FormDefinition.localization` the builder has authored (supported locales,
   * default locale) — persist it on the definition beside {@link value}.
   */
  public get localization(): LocalizationConfiguration | undefined {
    return this.ctrl.localization();
  }

  /**
   * The form's tests: scenarios in the test language, one `test "…"` block each. Like
   * `localization` it is an *initial* value the host sets with the form and reads back, on each
   * `builder-change`, to persist on the definition (`FormDefinition.tests`) beside {@link value}.
   * Setting it announces nothing and adds no undo step; the Tests panel edits it afterwards, each
   * Apply, Accept new behaviour or rename a step of the history.
   */
  public get tests(): FormTestConfiguration | undefined {
    return this.ctrl.tests();
  }

  public set tests(value: FormTestConfiguration | undefined) {
    this.ctrl.setTests(value, { silent: true });
    // Nor does it move Logic's Pinned-by line by itself.
    this.feedTestsPins();
    // A silent set tells nobody, so the panel is asked to read the block again (it may not be loaded: then it reads on adoption).
    const panel = this.testsPanelEl as (DatumBuilderTestsPanelElement & { refresh?: () => void }) | undefined;
    if (panel?.refresh) {
      panel.refresh();
    } else if (panel) {
      // Assigning the controller again re-subscribes and repaints, which re-reads the block.
      panel.controller = this.ctrl;
    }
  }

  /**
   * The committed {@link FormIdentity} the builder has authored (form id, version, schema
   * version) — persist it on the definition beside {@link value}. `undefined` when the host
   * gave the builder no identity to edit.
   */
  public get identity(): FormIdentity | undefined {
    return this.ctrl.identity();
  }

  /** Undoes on the mode the author is looking at (through its history first: {@link historyStep}). */
  public undo(): void {
    this.historyStep("undo");
  }

  public redo(): void {
    this.historyStep("redo");
  }

  /**
   * Every Undo and Redo of the builder comes here: the bar's
   * buttons, the canvas's and the outline's keys, the command palette, {@link undo} and
   * {@link redo}, and the agent's tools. The mode on the page is asked first
   * (`BuilderMode.history`): while a journey's Step view is up its one history over the form
   * and the shown journey takes back the last thing done, whichever controller it landed on.
   * Answering false (no such history, or nothing of its own left), `controller` steps its own
   * history, as before. `controller` defaults to the mode's on the page. Another one (the
   * form's, from a canvas trying the form), or any with `own` (the agent's tools, which take
   * back their own steps and never the person's), is stepped through the mode's history only by
   * the entry holding that controller's own step on top, with what was done with it on the
   * other controller (a rename and the journey's follow-up).
   */
  public historyStep(direction: "undo" | "redo", controller: BuilderController = this.activeMode.controller, options: { own?: boolean } = {}): void {
    const mode = this.activeMode;
    const history = mode.history?.();
    if (history) {
      const newest = controller === mode.controller && options.own !== true;
      const taken = newest ? (direction === "undo" ? history.undo() : history.redo()) : (history.stepOn?.(controller, direction) ?? false);
      if (taken) {
        return;
      }
    }
    if (direction === "undo") {
      controller.undo();
    } else {
      controller.redo();
    }
  }

  /**
   * The one function every surface's Undo and Redo keys step through: the outline, the fields panel,
   * the canvas and the lazy Print and Languages surfaces (set where each is fed). A surface that
   * handles Ctrl or Cmd+Z itself calls it, so a key pressed in any of them is the bar's Undo.
   */
  private readonly surfaceHistoryStep = (controller: BuilderController, direction: "undo" | "redo"): void => this.historyStep(direction, controller);

  /** Whether {@link historyStep} on the mode on the page would step: its history's say first, else its controller's. */
  public canHistoryStep(direction: "undo" | "redo"): boolean {
    const mode = this.activeMode;
    const history = mode.history?.();
    if (history && (direction === "undo" ? history.canUndo() : history.canRedo())) {
      return true;
    }
    return direction === "undo" ? mode.controller.canUndo() : mode.controller.canRedo();
  }

  /**
   * The host's translation catalog: a function answering it as it stands, asked when
   * the builder needs it. The Languages workspace marks the texts the page's catalog overrides
   * and shows them read-only. The catalog stays host data; the builder never writes it.
   */
  public set translationsSource(value: (() => TranslationsCatalogSource) | undefined) {
    this.translationsSourceValue = value;
    // The catalog the controller answers from is the new source's: an answer cached this tick is the old one's.
    this.hostCatalogTick = undefined;
    if (this.languagesEl) {
      // The surface reads the catalog live from the controller, so the flag's repaint draws the new source's entries.
      this.languagesEl.hostCatalog = value !== undefined;
    }
  }

  public get translationsSource(): (() => TranslationsCatalogSource) | undefined {
    return this.translationsSourceValue;
  }

  /**
   * The bar's file actions (see {@link BuilderFileActions}): New, Open and Download lead the
   * bar, a button for each action supplied and none for the others; unset, the bar shows none.
   * Each goes through the unsaved-edits guard of the document on the page
   * (`activeController.requestLeave`); New and Open ask before replacing the form (New does
   * not when the form has nothing to lose: no components, no settings on the form, no
   * languages, and the host's `isEmpty` agreeing), a file Open refuses shows its message on the bar,
   * and each completed action is reported as a `builder-file-action` event.
   */
  public set fileActions(value: BuilderFileActions | undefined) {
    this.fileActionsValue = value;
    this.syncFileActions();
  }

  public get fileActions(): BuilderFileActions | undefined {
    return this.fileActionsValue;
  }

  /**
   * What the whole definition would weigh with `extraBytes` more in it, against the most a load
   * accepts: how the inspector asks before it embeds a file picked into a `file` control (an ICC
   * profile) as base64. `<datum-form-builder>` sets it, since it alone sees every side of the
   * definition. Unset, nothing is asked.
   */
  public get embedBudget(): ((extraBytes: number) => DefinitionBudget | undefined) | undefined {
    return this.embedBudgetValue;
  }

  public set embedBudget(value: ((extraBytes: number) => DefinitionBudget | undefined) | undefined) {
    this.embedBudgetValue = value;
    this.syncEmbedBudget();
  }

  private syncEmbedBudget(): void {
    for (const panel of [this.propertiesEl, this.formSettingsEl]) {
      if (panel) {
        panel.embedBudget = this.embedBudgetValue;
      }
    }
  }

  /**
   * The longest form file the bar's Open reads, in bytes (2 MiB unless set, the cap the elements
   * hold a definition to; `max-definition-bytes` on `<datum-form-builder>` sets it here). A longer
   * file is refused by its size before any of it is read, so it never reaches `fileActions.open`
   * or a parser. `undefined` puts the 2 MiB back; anything but a whole number above 0 is a RangeError.
   */
  public get maxDefinitionBytes(): number {
    return this.maxDefinitionBytesValue;
  }

  public set maxDefinitionBytes(value: number | undefined) {
    if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError(`maxDefinitionBytes must be a whole number of bytes above 0, not ${String(value)}`);
    }
    this.maxDefinitionBytesValue = value ?? MAX_OPEN_FILE_BYTES;
  }

  /**
   * Every text of the definition that has translations: the form's components' and its header
   * and footer parts' (`BuilderController.translatableTexts`), then each registered mode's, in
   * the bar's order — the journeys' names, wording and page titles
   * (`BuilderMode.translatableTexts`). Each row carries its address in the
   * definition's `translations` map.
   */
  public translatableTexts(): TranslatableText[] {
    const texts = [...this.ctrl.translatableTexts()];
    for (const mode of this.modeMap.values()) {
      if (mode.id !== PRIMARY_BUILDER_MODE && mode.translatableTexts) {
        texts.push(...mode.translatableTexts(this.words.options()));
      }
    }
    return texts;
  }

  /** The host's own panels in the side column, each naming the strip item that opens it. */
  private hostPanels(): HTMLElement[] {
    const slot = this.rootNode?.querySelector<HTMLSlotElement>('slot[name="panel"]');
    // Flattened: a wrapper that forwards its own panel slot (datum-form-builder) hands on a slot, not the panels.
    return (slot?.assignedElements({ flatten: true }) ?? []).filter((el): el is HTMLElement => el instanceof HTMLElement);
  }

  /**
   * The host's own strip items, in the order it slotted them: what is assigned to the strip's
   * slot naming a panel in `data-panel`. They come after the shell's own, in the keyboard's
   * walk and in the selected state, as they do on screen.
   */
  /** Marks the host's strip items against the open panel, as {@link setPanel} marks the shell's. */
  private markHostStripItems(): void {
    for (const item of this.hostStripItems()) {
      item.setAttribute("aria-selected", String(item.dataset.panel === this.activePanel));
    }
  }

  private hostStripItems(): HTMLElement[] {
    const slot = this.rootNode?.querySelector<HTMLSlotElement>('[data-strip] slot[name="strip"]');
    return (slot?.assignedElements({ flatten: true }) ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.panel !== undefined
    );
  }

  /**
   * The net change to the form's languages since it was loaded or last saved: what a host
   * keeping a translation catalog applies to it when it saves. The File menu's
   * Save hands the same to `fileActions.save`; a host saving some other way reads it here,
   * applies it, then calls {@link markLocalesSaved}.
   */
  public localeChangesSinceSave(): LocaleChanges {
    return this.ctrl.localeChangesSinceSave();
  }

  /** The languages as they stand are the baseline: call it once the host has saved the form (and applied {@link localeChangesSinceSave}). */
  public markLocalesSaved(): void {
    this.ctrl.markLocalesSaved();
    this.localeTargets = new Map();
  }

  // --- internals ---------------------------------------------------

  private buildDom(): void {
    this.domGeneration += 1;
    const icons = this.iconSet();
    // Fresh markup has no phone parts up yet: the width observer applies the tier to it.
    this.phone = false;
    this.phoneTouched = false;
    this.menuOpen = false;
    this.moreOpen = false;
    this.resultsOpen = false;
    this.sheetKind = undefined;
    this.disposeSheetGestures();
    this.hostSlotHomes = [];
    this.surfaceSheets.clear();
    this.rootNode.innerHTML = `
      <style>${wrapperStyles()}</style>
      <style data-icon-css>${icons.css ?? ""}</style>
      <div class="wrap" part="wrap" data-shell="wrap">
        <div class="bar" part="bar" data-shell="bar">
          <div class="bar-lead" data-bar-lead>
          <!-- A phone's top row: Menu opens the drawer; in a designer the back title returns to its overview. -->
          <button type="button" class="menu-open" data-menu-open aria-haspopup="dialog" aria-expanded="false" aria-controls="menu-drawer"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"></path></svg><span class="menu-open-label" data-menu-open-label>Form</span><span class="menu-open-count" data-menu-open-count aria-hidden="true" hidden></span></button>
          <button type="button" class="document-back" data-document-back hidden><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M15 18l-6-6 6-6"></path></svg><span class="document-back-text"><span class="document-back-name" data-document-back-name></span> <span class="document-back-kind" data-document-back-kind></span></span><span class="sr-only" data-document-back-place></span></button>
          <div class="bar-start" part="bar-start">
            <slot name="toolbar-start"></slot>
            <span class="bar-sep" data-host-sep hidden></span>
            <span class="bar-history" data-bar-history>
            <button type="button" class="bar-btn" data-undo aria-label="Undo" data-tip="Undo (Cmd/Ctrl+Z)" data-t-attr="aria-label:shell.bar.undo;data-tip:shell.bar.undo.tip" disabled>${glyphSlot(icons, "undo")}</button>
            <button type="button" class="bar-btn" data-redo aria-label="Redo" data-tip="Redo (Cmd/Ctrl+Shift+Z)" data-t-attr="aria-label:shell.bar.redo;data-tip:shell.bar.redo.tip" disabled>${glyphSlot(icons, "redo")}</button>
            </span>
            <!-- The command palette: every command, filtered as you type. -->
            <button type="button" class="bar-btn" data-palette-open aria-label="Search commands" data-tip="Search commands (Cmd/Ctrl+K)" data-t-attr="aria-label:shell.bar.search;data-tip:shell.bar.search.tip"
              aria-keyshortcuts="Control+K Meta+K"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path></svg></button>
          </div>
          <!-- The workspaces: tabs on a wide bar, a menu on a narrow one (container query). -->
          <nav class="workspaces" part="workspaces" data-workspaces-nav aria-label="Workspace" data-t-attr="aria-label:shell.bar.workspace">
            <div class="workspace-tabs" role="tablist" aria-label="Workspace" data-t-attr="aria-label:shell.bar.workspace">${BUILDER_WORKSPACES.map(
              (id) => `<button type="button" class="workspace-tab" role="tab" data-workspace-tab="${id}" aria-selected="${id === "form"}" tabindex="${id === "form" ? 0 : -1}"><span data-t="shell.workspace.${id}">${escapeHtml(this.workspaceLabel(id))}</span></button>`
            ).join("")}</div>
            <select class="workspace-menu" data-workspace-menu aria-label="Workspace" data-t-attr="aria-label:shell.bar.workspace">${BUILDER_WORKSPACES.map(
              (id) => `<option value="${id}" data-t="shell.workspace.${id}">${escapeHtml(this.workspaceLabel(id))}</option>`
            ).join("")}</select>
          </nav>
          </div>
          <!-- The document on the page, by name and kind (its language is in Settings). -->
          <div class="bar-centre" data-bar-centre>
            <div class="documents" part="documents" data-documents hidden>
              <!-- In a journey's or a PDF layout's designer: the way back to the workspace's overview, leading the document's pill. -->
              <button type="button" class="bar-btn bar-back" data-overview-back hidden></button>
              <span class="bar-sep" data-overview-back-sep hidden></span>
              <div class="document-picker" data-document-picker-wrap></div>
              <div class="menu document-menu" role="menu" data-document-menu-popover hidden></div>
            </div>
          </div>
          <div class="bar-end" part="bar-end">
            <div class="bar-group mode-actions" data-mode-actions></div>
            <!-- Full window: the builder over the whole page it is embedded in. -->
            <button type="button" class="bar-btn tool-toggle" data-full-window aria-pressed="false" aria-label="Full window" data-tip="Full window">${fullWindowGlyph(false)}</button>
            <slot name="canvas-actions"></slot>
            <slot name="toolbar"></slot>
            <!-- Whether the form is unsaved: the shell's own, from saveState; the history slot below stays the host's. -->
            <span class="save-cue" data-save-cue hidden title="Changes not saved"><span class="save-cue-dot" aria-hidden="true"></span><span class="save-cue-text" data-save-cue-text>Changes not saved</span></span>
            <!-- A host's named places on the bar: each drawn only when filled. -->
            <slot name="history"></slot>
            <slot name="comments"></slot>
            <slot name="publish"></slot>
            <slot name="account"></slot>
            <!--
              The file menu, last on the bar: New, Open, Download and the host's Save,
              each there only when the host supplies it (fileActions). A message about a file
              shows beside it, outside the menu, so it stays in view once the menu is put away.
            -->
            <span class="file-actions" data-file-actions hidden>
              <span class="file-error" role="alert" data-file-error hidden><span class="file-error-message" data-file-error-message></span><button
                type="button" class="bar-btn file-error-dismiss" data-file-error-dismiss data-t="shell.file.dismiss">Dismiss</button></span>
              <button type="button" class="bar-btn file-menu-toggle" data-file-menu aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu" aria-label="Menu" data-tip="Menu" data-t-attr="aria-label:shell.file.menu;data-tip:shell.file.menu"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="12" cy="19" r="1.9"></circle></svg></button>
              <span class="menu file-menu" id="file-menu" role="menu" aria-label="Menu" data-t-attr="aria-label:shell.file.menu" data-file-menu-list hidden>
                <button type="button" class="menu-item file-item" role="menuitem" tabindex="-1" data-file-save hidden><span class="glyph">${saveGlyph()}</span><span class="file-item-label">Save</span><kbd class="file-item-key" data-file-save-key></kbd></button>
                <span class="file-sep" role="separator" data-file-save-sep hidden></span>
                <button type="button" class="menu-item file-item" role="menuitem" tabindex="-1" data-file-new hidden><span class="glyph">${glyphSlot(icons, "new-form")}</span><span class="file-item-label" data-t="shell.file.new">New form</span></button>
                <button type="button" class="menu-item file-item" role="menuitem" tabindex="-1" data-file-open hidden><span class="glyph">${glyphSlot(icons, "open-form")}</span><span class="file-item-label" data-t="shell.file.open">Open form file…</span></button>
                <button type="button" class="menu-item file-item" role="menuitem" tabindex="-1" data-file-download hidden><span class="glyph">${glyphSlot(icons, "download-form")}</span><span class="file-item-label" data-t="shell.file.download">Download form</span></button>
                <!-- Dark mode: the shell's own colour scheme, at the menu's foot, naming the scheme it would switch to (a moon for dark, a sun for light); a rule above it only when a file item sits above. -->
                <span class="file-sep" role="separator" data-file-scheme-sep hidden></span>
                <button type="button" class="menu-item file-item" role="menuitem" tabindex="-1" data-file-scheme hidden><span class="glyph" data-file-scheme-moon><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"></path></svg></span><span class="glyph" data-file-scheme-sun hidden><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4"></path><circle cx="12" cy="12" r="4.5"></circle></svg></span><span class="file-item-label" data-file-scheme-label>Dark mode</span></button>
              </span>
            </span>
          </div>
        </div>
        <div class="body">
          <div class="rails" data-rails>
          <!-- The component rail: the most used types, a click adding one after the
               selection, and All components for the palette. Form, on the form, only. -->
          <div class="add-rail" role="toolbar" aria-orientation="vertical" aria-label="Add a component" data-t-attr="aria-label:shell.rail.label" data-add-rail hidden></div>
          <div class="strip" data-strip-card>
            <div class="strip-tabs" role="tablist" aria-orientation="vertical" aria-label="Panels" data-t-attr="aria-label:shell.strip.panels" data-strip>
            ${stripItems(icons, this.words)}
            <!-- The host's own strip items: launchers for what the page wires around the
                 builder, sized here and styled by the host, like its bar slots. -->
            <slot name="strip"></slot>
            </div>
          </div>
          <!-- A phone's bottom bar: Try it, Try it's results, and More for the items past four. -->
          <button type="button" class="bottom-btn" data-bottom-try aria-pressed="false" hidden><span class="glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="${PHONE_MENU_ICONS.try}"></path></svg></span><span class="strip-label" data-t="shell.bottom.try">Try it</span></button>
          <button type="button" class="bottom-btn" data-bottom-results aria-haspopup="dialog" aria-expanded="false" hidden><span class="glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 11l3 3 8-8M20 12v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1h11"></path></svg></span><span class="strip-label" data-t="shell.bottom.results">Results</span></button>
          <button type="button" class="bottom-btn" data-bottom-more aria-haspopup="dialog" aria-expanded="false" hidden><span class="glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="19" cy="12" r="1.9"></circle></svg></span><span class="strip-label" data-t="shell.bottom.more">More</span></button>
          </div>
          <div class="side" id="side" role="tabpanel" data-side tabindex="-1">
            <${DATUM_BUILDER_TOOLBAR_TAG} class="slot toolbar" data-floating></${DATUM_BUILDER_TOOLBAR_TAG}>
            <${DATUM_BUILDER_OUTLINE_TAG} class="slot outline" data-floating hidden></${DATUM_BUILDER_OUTLINE_TAG}>
            <${DATUM_BUILDER_FORM_FIELDS_TAG} class="slot fields" data-floating hidden></${DATUM_BUILDER_FORM_FIELDS_TAG}>
            <${DATUM_BUILDER_FORM_PANEL_TAG} class="slot form-settings" data-floating hidden></${DATUM_BUILDER_FORM_PANEL_TAG}>
            <${DATUM_BUILDER_CHROME_PANEL_TAG} class="slot chrome-settings" data-floating hidden></${DATUM_BUILDER_CHROME_PANEL_TAG}>
            <${DATUM_BUILDER_VARIABLES_PANEL_TAG} class="slot variables" data-floating hidden></${DATUM_BUILDER_VARIABLES_PANEL_TAG}>
            <${DATUM_BUILDER_TESTS_PANEL_TAG} class="slot tests" data-floating hidden></${DATUM_BUILDER_TESTS_PANEL_TAG}>
            <!-- A host's own panels, each named by the data-panel its strip item carries. -->
            <slot name="panel"></slot>
            <div class="slot view-panel" data-view-panel data-floating hidden>
              <div class="panel card-stack">
                <div class="card"><h2 class="card-title" data-t="view.title">View</h2></div>
                <div class="card view-group">
                <label class="view-row" data-width-field>
                  <span class="view-label" data-t="view.width.label">Preview width</span>
                  <select data-preview-width aria-label="Preview width" data-t-attr="aria-label:view.width.label">${PREVIEW_WIDTHS.map(
                    (option) => `<option value="${option.value}"${option.value === "" ? ' data-t="view.width.fit"' : ""}>${escapeHtml(option.label)}</option>`
                  ).join("")}<option value="custom" hidden data-t="view.width.custom">Custom</option></select>
                  <span class="view-note" data-width-readout hidden></span>
                </label>
                <label class="view-row" data-binding-field hidden>
                  <span class="view-label" data-t="view.theme.label">Design system</span>
                  <select data-binding aria-label="Design system" data-t-attr="aria-label:view.theme.label"></select>
                </label>
                </div>
                <!-- What a rule hides, drawn on the canvas or left out (shown unless turned off). -->
                <div class="card view-group" data-show-hidden-field>
                  <label class="view-check"><input type="checkbox" data-show-hidden checked aria-describedby="show-hidden-note"> <span data-t="view.showHidden.label">Show components a rule hides</span></label>
                  <p class="view-note" id="show-hidden-note" data-t="view.showHidden.note">Drawn faded while their rule hides them, so you can reach and edit them. Try it shows the form as a person sees it.</p>
                </div>
                <!-- The host's chrome, for the preview only: what the page showing the form sets. -->
                <fieldset class="card view-group" data-preview-chrome>
                  <legend class="card-heading" data-t="view.chrome.legend">Form chrome</legend>
                  <p class="view-note" id="preview-chrome-note" data-t="view.chrome.note">As the page showing the form sets it. For the preview only: the form keeps its own settings.</p>
                  <label class="view-row">
                    <span class="view-label" data-t="view.chrome.frame">The page's frame</span>
                    <select data-preview-chrome-frame aria-describedby="preview-chrome-note"></select>
                  </label>
                  <label class="view-check"><input type="checkbox" data-preview-chrome-fixed> <span data-t="view.chrome.fixed">The page fixes its frame</span></label>
                  <label class="view-check"><input type="checkbox" data-preview-chrome-parts checked> <span data-t="view.chrome.parts">Show the form's header and footer</span></label>
                  <label class="view-check"><input type="checkbox" data-preview-chrome-switcher checked> <span data-t="view.chrome.switcher">Show the form's language switcher</span></label>
                </fieldset>
              </div>
            </div>
            <div class="slot view-panel settings-panel" data-settings-panel data-floating hidden>
              <div class="panel card-stack">
                <div class="card"><h2 class="card-title" data-t="settings.title">Settings</h2></div>
                <!-- The language the form is shown in while you build. -->
                <section class="card settings-section" aria-labelledby="settings-language-title" data-settings-language>
                  <h3 class="card-heading" id="settings-language-title" data-t="settings.language.title">Language</h3>
                  <p class="view-note" data-settings-language-note data-t="settings.language.note">The language the canvas shows the form in. The form's languages and translations are in Languages.</p>
                  <${DATUM_LOCALE_SELECT_TAG} data-locale-select show-label label="Show the form in" data-t-attr="label:settings.language.select"></${DATUM_LOCALE_SELECT_TAG}>
                  <p class="view-note" data-settings-language-none hidden data-t="settings.language.none">The form is in one language. Add others in Languages.</p>
                </section>
                <!-- What Submit does in Try it: a stand-in for the page's server, for this session. -->
                <section class="card settings-section" aria-labelledby="settings-submit-title" data-settings-submit>
                  <h3 class="card-heading" id="settings-submit-title" data-t="settings.submit.title">Submitting in Try it</h3>
                  <p class="view-note" data-t="settings.submit.hint">These values are what Try it uses, in Form, Logic, Journeys and PDF.</p>
                  <p class="view-note" data-t="settings.submit.note">What Submit does while you try the form: a stand-in for the page's server. The form keeps none of it.</p>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.submit.outcome.label">What the server does</span>
                    <select data-try-setting="outcome">
                      <option value="accept" data-t="settings.submit.outcome.accept">Accepts the form</option>
                      <option value="refuse" data-t="settings.submit.outcome.refuse">Refuses the form</option>
                      <option value="fail" data-t="settings.submit.outcome.fail">Cannot be reached</option>
                    </select>
                  </label>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.submit.delay.label">How long it takes (milliseconds)</span>
                    <input type="number" min="0" max="10000" step="100" inputmode="numeric" data-try-setting="delayMs" aria-describedby="settings-submit-delay-note">
                    <span class="view-note" id="settings-submit-delay-note" data-t="settings.submit.delay.note">From 0 to 10000.</span>
                  </label>
                  <fieldset class="view-set" data-try-placement="statusPlacement">
                    <legend class="view-label" data-t="settings.submit.status.legend">Where "Submitting…" shows</legend>
                    <label class="view-check"><input type="checkbox" value="top"> <span data-t="settings.placement.top">Top</span></label>
                    <label class="view-check"><input type="checkbox" value="bottom"> <span data-t="settings.placement.bottom">Bottom</span></label>
                  </fieldset>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.submit.statusText.label">Status text</span>
                    <input type="text" data-try-setting="statusText" placeholder="Submitting…" data-t-attr="placeholder:settings.submit.statusText.placeholder" aria-describedby="settings-submit-status-note">
                    <span class="view-note" id="settings-submit-status-note" data-t="settings.submit.statusText.note">Blank uses the form's own wording.</span>
                  </label>
                  <fieldset class="view-set">
                    <legend class="view-label" data-t="settings.receipt.legend">The receipt, when the server accepts</legend>
                    <label class="view-row">
                      <span class="view-label" data-t="settings.receipt.kind">Kind</span>
                      <select data-try-setting="receipt.kind">
                        <option value="success" data-t="settings.receipt.kind.success">Success</option>
                        <option value="info" data-t="settings.receipt.kind.info">Information</option>
                      </select>
                    </label>
                    <label class="view-row"><span class="view-label" data-t="settings.receipt.title">Title</span><input type="text" data-try-setting="receipt.title"></label>
                    <label class="view-row"><span class="view-label" data-t="settings.receipt.message">Message</span><input type="text" data-try-setting="receipt.message"></label>
                    <label class="view-row"><span class="view-label" data-t="settings.receipt.detailLabel">Reference label</span><input type="text" data-try-setting="receipt.detailLabel"></label>
                    <label class="view-row">
                      <span class="view-label" data-t="settings.receipt.reference">Reference</span>
                      <input type="text" data-try-setting="receipt.referencePattern" aria-describedby="settings-submit-reference-note">
                      <span class="view-note" id="settings-submit-reference-note" data-t="settings.receipt.reference.note">{n} becomes six random digits. Blank, the receipt shows no reference.</span>
                    </label>
                    <fieldset class="view-set" data-try-placement="receipt.placement">
                      <legend class="view-label" data-t="settings.receipt.placement">Where the receipt shows</legend>
                      <label class="view-check"><input type="checkbox" value="top"> <span data-t="settings.placement.top">Top</span></label>
                      <label class="view-check"><input type="checkbox" value="bottom"> <span data-t="settings.placement.bottom">Bottom</span></label>
                    </fieldset>
                  </fieldset>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.refusal.label">Refusal message</span>
                    <input type="text" data-try-setting="refusalMessage">
                  </label>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.afterAccept.label">After the server accepts</span>
                    <select data-try-setting="afterAccept">
                      <option value="editable" data-t="settings.afterAccept.editable">Keep the answers editable</option>
                      <option value="readonly" data-t="settings.afterAccept.readonly">Show the answers read only</option>
                    </select>
                  </label>
                </section>
                <!-- Host values: what the rules read under host., for this session; preview state the form never keeps. -->
                <section class="card settings-section" aria-labelledby="settings-host-title" data-settings-host>
                  <h3 class="card-heading" id="settings-host-title" data-t="settings.host.title">Host values</h3>
                  <p class="view-note" data-t="settings.host.note">What the page gives the form under host., for example host.role. Give some here to try a rule that reads them; the form and the page keep none of it.</p>
                  <p class="view-note" data-settings-host-reads data-t="settings.host.reads" hidden>A rule or calculation in this form reads host values.</p>
                  <label class="view-row">
                    <span class="view-label" data-t="settings.host.label">Host values (a JSON object)</span>
                    <textarea data-host-values rows="4" spellcheck="false" autocomplete="off" placeholder='{ "role": "admin" }' data-t-attr="placeholder:settings.host.placeholder" aria-describedby="settings-host-problem"></textarea>
                  </label>
                  <p class="source-error" id="settings-host-problem" role="alert" data-host-problem hidden></p>
                </section>
                <!-- Simulated data sources: lists to try the form with, for this session. -->
                <section class="card settings-section" aria-labelledby="settings-sources-title">
                  <h3 class="card-heading" id="settings-sources-title" data-t="settings.sources.title">Data sources</h3>
                  <p class="view-note" data-t="settings.sources.note">The lists the form's choices come from. Give one a list of your own to try the form with it; the form and the page keep theirs.</p>
                  <div data-settings-sources></div>
                </section>
              </div>
            </div>
          </div>
          <div class="resizer" data-resizer="side"></div>
          <${DATUM_BUILDER_CANVAS_TAG} class="slot canvas"></${DATUM_BUILDER_CANVAS_TAG}>
          <!-- Logic's surface, in the canvas's place while Logic is on; its chunk loads then. -->
          <div class="logic-host" data-logic-host hidden></div>
          <!-- Data's surface, likewise. -->
          <div class="logic-host" data-data-host hidden></div>
          <div class="logic-host" data-languages-host hidden></div>
          <div class="logic-host" data-print-host hidden></div>
          <!-- The Journeys and PDF overviews, while that workspace has no document open. -->
          <div class="logic-host" data-overview-host hidden></div>
          <div class="resizer" data-resizer="props"></div>
          <${DATUM_BUILDER_PROPERTIES_TAG} class="slot props" data-floating></${DATUM_BUILDER_PROPERTIES_TAG}>
        </div>
        <!-- A phone's overlays: the scrim, the sheets' handle row, More, and the menu drawer. -->
        <div class="db-scrim" data-scrim aria-hidden="true"></div>
        <div class="sheet-head" data-sheet-head hidden>
          <button type="button" class="sheet-grab" data-sheet-grab aria-expanded="false" aria-label="Drag to close or tap to expand" data-t-attr="aria-label:shell.sheet.grab"></button>
          <button type="button" class="sheet-close" data-sheet-close aria-label="Close" data-t-attr="aria-label:shell.sheet.close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>
        </div>
        <section class="more-sheet" role="dialog" aria-modal="true" aria-labelledby="more-title" data-more-sheet hidden>
          <div class="more-head"><h2 id="more-title" tabindex="-1" data-more-title data-t="shell.more.title">More panels</h2><button type="button" class="sheet-close" data-more-close aria-label="Close" data-t-attr="aria-label:shell.sheet.close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>
          <div class="more-list" data-more-list></div>
        </section>
        <div class="menu-drawer" id="menu-drawer" role="dialog" aria-modal="true" aria-labelledby="menu-title" data-menu-drawer hidden>
          <div class="menu-head">
            <div class="menu-head-text"><div class="menu-title" id="menu-title" tabindex="-1" data-menu-title></div><div class="menu-state" data-menu-state></div></div>
            <button type="button" class="menu-close" data-menu-close aria-label="Close menu" data-t-attr="aria-label:shell.menu.close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>
          </div>
          <div class="menu-body">
            <div data-menu-sections></div>
            <section class="menu-section" aria-labelledby="menu-heading-host" data-menu-host-section hidden>
              <h2 class="menu-heading" id="menu-heading-host" data-t="shell.menu.host">From the page</h2>
              <div class="menu-host" data-menu-host></div>
            </section>
          </div>
        </div>
      </div>
      <dialog class="db-confirm" role="alertdialog" aria-labelledby="file-confirm-title"
        aria-describedby="file-confirm-message" data-file-confirm>
        <h4 id="file-confirm-title" data-file-confirm-title></h4>
        <p id="file-confirm-message" data-file-confirm-message></p>
        <div class="db-confirm-actions">
          <button type="button" class="btn" data-file-confirm-cancel autofocus data-t="shell.file.cancel">Cancel</button>
          <button type="button" class="btn danger" data-file-confirm-ok></button>
        </div>
      </dialog>
      <input type="file" accept="application/json,.json" hidden data-file-input aria-label="Form file" data-t-attr="aria-label:shell.file.input" />`;

    // Found by its data hook, not its class: the class is styling and the studio look renames it.
    this.wrapEl = this.rootNode.querySelector("[data-shell=wrap]") as HTMLDivElement;
    this.toolbarEl = this.rootNode.querySelector(".toolbar") as DatumBuilderToolbarElement;
    this.outlineEl = this.rootNode.querySelector(".outline") as DatumBuilderOutlineElement;
    this.fieldsEl = this.rootNode.querySelector(".fields") as DatumBuilderFormFieldsElement;
    this.canvasEl = this.rootNode.querySelector(".canvas") as DatumBuilderCanvasElement;
    // What a host lent Try it before the shell drew.
    this.canvasEl.serverChecks = this.serverChecksValue;
    this.canvasEl.tryPdf = this.tryPdfValue;
    // Submit in Try it follows the form's Submitting in Try it settings, whichever tree is on the canvas.
    this.canvasEl.trySettingsController = this.ctrl;
    this.canvasEl.printTheme = this.printThemeValue;
    // Try it's Preview PDF goes through the PDF mode from every workspace; a page with
    // none falls back to the canvas's renderer, which picks by the answers from a host mode's catalog.
    this.canvasEl.tryPdfMode = () => this.pdfTryMode();
    // Try it asks, when it would call the form unsubmittable, whether the form opens as a journey: a journey's
    // last page draws its own Submit, so the root tree having no Submit button is no fault then.
    this.canvasEl.addEventListener("builder-query-opens-as-journey", (event) => {
      (event as CustomEvent<{ journey: boolean }>).detail.journey = this.opensAsJourney();
    });
    this.canvasEl.pdfConfigurationSource = () => (this.pdfTryMode() || this.modeMap.has(DESIGNER_WORKSPACES.pdf) ? undefined : this.definitionPdf());
    const addRail = this.rootNode.querySelector<HTMLElement>("[data-add-rail]");
    addRail?.addEventListener("click", (event) => this.onRailClick(event));
    addRail?.addEventListener("keydown", (event) => this.onRailKey(event as KeyboardEvent));
    addRail?.addEventListener("dragstart", (event) => this.onRailDragStart(event as DragEvent));
    this.propertiesEl = this.rootNode.querySelector(".props") as DatumBuilderPropertiesElement;
    this.formSettingsEl = this.rootNode.querySelector(".form-settings") as DatumBuilderFormPanelElement;
    this.syncEmbedBudget();
    this.propertiesEl.formulaReferenceHref = this.formulaReferenceHrefValue;
    this.formSettingsEl.formulaReferenceHref = this.formulaReferenceHrefValue;
    // The Header & footer and Variables panels: the bare elements until their chunk is
    // asked for by opening them; a chunk already on the page (an earlier open, any shell) wires
    // them now, as before, so only the first open on a page waits.
    this.chromePanelHost = this.rootNode.querySelector<HTMLElement>(".chrome-settings") ?? undefined;
    this.variablesPanelHost = this.rootNode.querySelector<HTMLElement>(".variables") ?? undefined;
    this.testsPanelHost = this.rootNode.querySelector<HTMLElement>(".slot.tests") ?? undefined;
    this.wireTestsPanelHost();
    this.chromePanelEl = undefined;
    this.variablesPanelEl = undefined;
    this.testsPanelEl = undefined;
    this.lazyPanelLoads.clear();
    // The workspace surfaces and the palette lived in the markup just replaced: drop them and
    // let the next visit load them into the new hosts (never carry the old elements over).
    this.logicEl = undefined;
    this.dataEl = undefined;
    this.languagesEl = undefined;
    this.printEl = undefined;
    this.overviewEl = undefined;
    this.paletteEl = undefined;
    this.logicLoading = false;
    this.dataLoading = false;
    this.languagesLoading = false;
    this.printLoading = false;
    this.overviewLoading = false;
    this.lazyPanelNotes.clear();
    for (const id of ["chrome", "variables", "tests"] as const) {
      const host = this.lazyPanelHost(id);
      if (host && !this.panelOff(id) && panelLoader(id)?.loaded()) {
        this.adoptLazyPanelSafely(id, host, false);
      }
    }
    this.applyFormulaFunctions();
    this.viewPanelEl = this.rootNode.querySelector("[data-view-panel]") as HTMLElement;
    this.settingsPanelEl = this.rootNode.querySelector("[data-settings-panel]") as HTMLElement;
    this.sourcesSignature = undefined;
    this.hostValuesProblem = undefined;
    this.hostReadsSignature = undefined;
    if (this.textLocaleValue !== undefined || this.textCatalogValue !== undefined) {
      // Words set before the markup was drawn (a host sets them on creation): the English in the markup gives way.
      this.applyShellTexts();
    }
    this.documentsEl = this.rootNode.querySelector("[data-documents]") as HTMLDivElement;
    // Fresh markup: whatever the tabs last drew is gone with it.
    this.documentsSignature = undefined;
    this.modeActionsEl = this.rootNode.querySelector("[data-mode-actions]") as HTMLElement;
    // The workspace tabs: one Tab stop, arrows between the tabs, Enter or Space to open one.
    const tablist = this.rootNode.querySelector<HTMLElement>(".workspace-tabs");
    tablist?.addEventListener("keydown", (event: KeyboardEvent) => {
      const tabs = [...tablist.querySelectorAll<HTMLElement>("[data-workspace-tab]:not([hidden])")];
      const at = tabs.indexOf(event.target as HTMLElement);
      if (at < 0) {
        return;
      }
      const next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
      if (next) {
        event.preventDefault();
        for (const tab of tabs) tab.tabIndex = tab === next ? 0 : -1;
        next.focus();
      }
    });
    // The narrow bar's menu: a switch the guard holds puts the menu back until it goes through.
    const workspaceMenu = this.rootNode.querySelector<HTMLSelectElement>("[data-workspace-menu]");
    workspaceMenu?.addEventListener("change", () => {
      const id = workspaceMenu.value;
      if (isWorkspace(id) && !this.setWorkspace(id)) {
        workspaceMenu.value = this.workspaceValue;
      }
    });
    // The outline marks the components the canvas is hiding, so it stays an index of the whole form.
    this.outlineEl.hiddenIds = () => this.canvasEl.hiddenComponentIds();
    // The canvas's and the outline's Undo and Redo keys go through the shell's one Undo.
    this.outlineEl.historyStep = this.surfaceHistoryStep;
    this.fieldsEl.historyStep = this.surfaceHistoryStep;
    this.canvasEl.historyStep = this.surfaceHistoryStep;
    // Host controls arriving on, or leaving, the leading slot decide whether the divider between
    // them and undo/redo shows.
    this.rootNode.querySelectorAll("slot").forEach((slot) => {
      slot.addEventListener("slotchange", () => {
        // A host's strip items arrive or go: they follow the workspace like the shell's own.
        this.applyWorkspace();
        this.syncHostSeparator();
        this.syncMenuHostSection();
        // A host item slotted after a panel opened shows its state at once, not at the next change.
        if (slot.name === "strip") {
          this.markHostStripItems();
        }
      });
    });
    this.syncHostSeparator();
    this.translationsSource = this.translationsSourceValue;
    this.wireFileActions();
    this.fileActions = this.fileActionsValue;
    // The `features` list and `hidden-panels`: the strip and the parts of the bar, the
    // canvas and the inspector they leave out, before any panel is pointed at a controller or opened.
    this.syncStripItems();
    this.syncFeatureParts();

    // Fresh panels have no controller and no Form fields yet, and the bar has heard no controller
    // since a disconnect unbound it: the re-point below is made in full, whatever was pointed before.
    this.pointedController = undefined;
    this.fieldsSource = undefined;
    this.renderDocuments();
    this.applyPanelControllers();
    this.applyTheme();
    this.applyLayout();
    // The first draw of the panel state is the shell's own, not a move a host is told of.
    this.quietPanel = true;
    try {
      this.setPanel(this.activePanel);
    } finally {
      this.quietPanel = false;
    }
    this.syncInspector();

    // The shadow root and the host outlive a rebuild of the markup, so these listeners are tied to one
    // controller per build: a reconnect rebuilds the DOM and would otherwise stack a second copy of each
    // (Full window toggled twice, Cmd+S saved twice).
    this.shellListeners?.abort();
    const shellListeners = new AbortController();
    this.shellListeners = shellListeners;
    const listen = (target: EventTarget, type: string, listener: (event: Event) => void): void => {
      target.addEventListener(type, listener, { signal: shellListeners.signal });
    };
    listen(this.rootNode, "click", (event) => this.onClick(event));
    listen(this.rootNode, "change", (event) => this.onChange(event));
    listen(this.rootNode, "keydown", (event) => this.onKeyDown(event as KeyboardEvent));
    listen(this.rootNode, "focusout", (event) => this.onFocusOut(event as FocusEvent));
    // The bar's locale switcher moves the form's locale; the event is composed, so it is heard here.
    listen(this.rootNode, "locale-change", (event) => {
      this.followBarLocale((event as CustomEvent<{ locale: string }>).detail?.locale);
    });
    // Languages: a text's component in Form, the Header & footer panel. Leaving goes
    // through the guard, so typed translations not applied are asked about first. The same event
    // goes the other way: a panel's "Open in Languages" line names the
    // component, and Languages opens filtered to it. The surface's own copy comes from the surface.
    listen(this.rootNode, "builder-languages-goto", (event) => {
      const detail = (event as CustomEvent<BuilderLanguagesGotoDetail>).detail;
      if (detail?.kind === "chrome") {
        if (detail.partId) {
          this.openLanguagesFor({ kind: "chrome", partId: detail.partId });
        }
        return;
      }
      const id = detail?.componentId;
      if (!id) {
        return;
      }
      if (this.languagesEl !== undefined && event.composedPath().includes(this.languagesEl)) {
        this.leaveLanguagesFor(() => this.activeMode.controller.select(id));
      } else {
        this.openLanguagesFor({ componentId: id });
      }
    });
    // A panel asks for a workspace by name.
    listen(this.rootNode, "builder-open-workspace", (event) => {
      const workspace = (event as CustomEvent<{ workspace: string }>).detail?.workspace;
      if (isWorkspace(workspace)) {
        this.setWorkspace(workspace);
      }
    });
    // The Form panel's Header and Footer rows open the Header & footer panel on that region;
    // the event is composed, so it is heard here from the panel's own root.
    listen(this.rootNode, "builder-open-panel", (event) => {
      const detail = (event as CustomEvent<BuilderOpenPanelDetail>).detail;
      if (detail?.panel === "chrome" && !this.chromeItemHidden()) {
        this.setPanel("chrome");
        // At once when the panel's chunk is on the page; else once it has loaded, if the panel is still the one open.
        const region = detail.region ?? "header";
        if (this.chromePanelEl) {
          this.chromePanelEl.focusRegion(region);
        } else {
          const host = this.chromePanelHost;
          void this.ensureLazyPanel("chrome").then(() => {
            if (this.chromePanelEl && this.chromePanelHost === host && this.activePanel === "chrome") {
              this.chromePanelEl.focusRegion(region);
            }
          });
        }
      } else if (detail?.panel === "form") {
        // The Header & footer panel's Save held back by a problem of the root's draft, whose box is here.
        this.setPanel("form");
        this.formSettingsEl.showProblem(detail.problem);
      }
    });
    // A Form panel row's button opens the mode that owns the row; the event is composed.
    listen(this.rootNode, "builder-open-mode", (event) => {
      const detail = (event as CustomEvent<BuilderOpenModeDetail>).detail;
      if (!detail || !this.modeMap.has(detail.mode)) {
        return;
      }
      if (detail.document !== undefined) {
        this.selectDocument(detail.mode, detail.document);
      } else {
        this.setMode(detail.mode);
      }
    });

    // The command palette: its bar button, and Ctrl+K / Cmd+K anywhere in the builder.
    listen(this.rootNode, "click", (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-palette-open]")) {
        void this.openPalette();
      }
      if ((event.target as HTMLElement | null)?.closest?.("[data-full-window]")) {
        this.fullWindow = !this.fullWindow;
      }
    });
    listen(this, "keydown", (raw) => {
      const event = raw as KeyboardEvent;
      // Without the `palette` feature the key is the page's.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k" && this.featureEnabled("palette")) {
        event.preventDefault();
        void this.openPalette();
      }
      // Save: the host's, when it lends one; otherwise the key is the page's.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s" && this.suppliedFileActions().save) {
        event.preventDefault();
        this.fileSave();
      }
    });
    // Logic's read-only rules open their document's designer; its failure card retries.
    listen(this.rootNode, "logic-open-document", (event) => {
      const detail = (event as CustomEvent<LogicOpenDocumentDetail>).detail;
      if (detail && this.modeMap.has(detail.mode)) {
        this.selectDocument(detail.mode, detail.documentId);
      }
    });
    // The rule editor's Pinned-by line asks for a test to open, or one to be written for the rule.
    listen(this.rootNode, "builder-logic-open-test", (event) => {
      const detail = (event as CustomEvent<BuilderLogicOpenTestDetail>).detail;
      if (detail && typeof detail.entryId === "string" && detail.entryId !== "") {
        void this.withTestsPanel((panel) => panel.openEntry?.(detail.entryId));
      }
    });
    // The Journeys mode tells the shell itself when a page or a journey takes another id, so a host that
    // wires the mode by hand needs no forwarding; it takes the path `followJourneyChange` takes.
    listen(this.rootNode, "builder-journey-rename", (event) => {
      const detail = (event as CustomEvent<{ kind?: unknown; journeyId?: unknown; from?: unknown; to?: unknown }>).detail;
      if (detail?.kind !== "page" && detail?.kind !== "journey") {
        return;
      }
      this.followJourneyChange({ reason: detail.kind === "page" ? "page-rename" : "journey-rename", renamed: { journeyId: detail.journeyId, from: detail.from, to: detail.to } });
    });
    // The canvas ends a recording by itself (the bar's Stop, Clear answers, Back to editing); the panel hears it here at
    // once instead of at its next paint. `stopRecording` is idempotent, so the panel's own stop echoing back is harmless.
    listen(this.rootNode, "canvas-record-change", (event) => {
      const detail = (event as CustomEvent<{ recording?: boolean; ready?: boolean }>).detail;
      const recording = detail?.recording === true;
      this.wrapEl?.toggleAttribute("data-tests-recording", recording);
      const panel = this.testsPanelHost as (HTMLElement & { stopRecording?: () => void; recordingReady?: () => void }) | undefined;
      if (detail?.recording === false) {
        panel?.stopRecording?.();
      } else if (recording && detail?.ready === true) {
        // The Try it chunk arrived after Record started: the panel takes the form as it was before the first step.
        panel?.recordingReady?.();
      }
    });
    listen(this.rootNode, "builder-logic-write-test", (event) => {
      const detail = (event as CustomEvent<BuilderLogicWriteTestDetail>).detail;
      if (detail && typeof detail.ruleId === "string" && detail.ruleId !== "") {
        void this.withTestsPanel((panel) => panel.writeTestFor?.(detail.ruleId));
      }
    });
    listen(this.rootNode, "click", (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-logic-retry]")) {
        this.syncLogic();
      }
      if ((event.target as HTMLElement | null)?.closest?.("[data-languages-retry]")) {
        this.syncLanguages();
      }
      if ((event.target as HTMLElement | null)?.closest?.("[data-print-retry]")) {
        this.syncPrint();
      }
      if ((event.target as HTMLElement | null)?.closest?.("[data-data-retry]")) {
        this.syncData();
      }
      if ((event.target as HTMLElement | null)?.closest?.("[data-overview-retry]")) {
        this.syncOverview();
      }
      // A lazy strip panel's failure card.
      const panelRetry = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-panel-retry]")?.dataset.panelRetry;
      if (panelRetry === "chrome" || panelRetry === "variables") {
        void this.ensureLazyPanel(panelRetry);
      }
    });
    // An overview's cards: Open puts the document's designer on the page; New starts the mode's add flow.
    listen(this.rootNode, "overview-open", (event) => {
      const detail = (event as CustomEvent<OverviewOpenDetail>).detail;
      if (!detail) {
        return;
      }
      if (detail.documentId !== undefined && this.modeMap.has(detail.mode)) {
        this.selectDocument(detail.mode, detail.documentId);
      } else if (this.modeMap.has(detail.mode)) {
        this.setMode(detail.mode);
      }
    });
    listen(this.rootNode, "overview-add", (event) => {
      const detail = (event as CustomEvent<OverviewAddDetail>).detail;
      const mode = detail ? this.modeMap.get(detail.mode) : undefined;
      if (mode?.documents?.add) {
        // The popover opens under the overview's own New (the event comes from the overview element itself).
        const anchor = this.overviewEl?.shadowRoot?.querySelector<HTMLElement>(`[data-overview-add="${mode.id}"]`) ?? undefined;
        void this.addFromOverview(mode, anchor);
      }
    });
    // "‹ Journeys" / "‹ Layouts" on the bar in a designer: the form back on the page, the workspace kept, on its overview.
    listen(this.rootNode, "click", (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-overview-back]")) {
        this.backToOverview();
      }
    });
    // A click on empty canvas puts the side panel away with the selection (the canvas has asked about unsaved edits).
    listen(this.rootNode, "canvas-background", () => {
      if (this.activePanel !== undefined) {
        this.setPanel(undefined);
      }
    });
    // Try it's panel takes the inspector's place: the drawer steps aside while the
    // canvas previews, the selection kept, so Back to editing brings the inspector back.
    listen(this.rootNode, "canvas-preview-change", (event) => {
      const trying = (event as CustomEvent<{ previewing: boolean }>).detail?.previewing === true;
      this.wrapEl?.toggleAttribute("data-trying", trying);
      // Try it in a designer's workspace tries the FORM: said before the canvas paints
      // (the setter dispatches this first), so its paint draws the form in the designer's place.
      // A host's own mode in the Form workspace tries its own tree, as it always did.
      if (this.canvasEl && event.target === this.canvasEl) {
        const designer = isDesignerWorkspace(this.workspaceValue) && this.activeMode.id !== PRIMARY_BUILDER_MODE;
        this.canvasEl.tryForm = trying && designer ? { controller: this.ctrl, mode: this.activeMode, workspace: this.workspaceValue } : undefined;
      }
      // Back to editing: a mode previewing the answers (a PDF layout's field previews) catches up,
      // once the canvas's paint has put the tried answers back in its store.
      if (!trying) {
        queueMicrotask(() => {
          // What was typed in Try it is not the form's: the answers go with it, so the
          // edit canvas draws the form's defaults and the next Try it starts empty. After the paint, which hands a session's answers back first.
          if (this.canvasEl &&!this.canvasEl.previewing && Object.keys(this.triedAnswers()).length > 0) {
            this.canvasEl.clearTriedAnswers();
          }
          for (const mode of this.modeMap.values()) {
            mode.valuesChanged?.();
          }
        });
      }
      // A phone's results sheet goes with the preview.
      if (!trying && this.resultsOpen) {
        this.setResults(false);
      }
      // The side column goes too: the page makes room for Try it's panel at the end, and a
      // drawer at the start would then lie over the form. It comes back on Back to editing,
      // unless the author opened another meanwhile.
      if (trying) {
        this.panelBeforeTrying = this.activePanel;
        // Record keeps the Tests drawer beside the form it writes from:
        // its live lines, Assert this and Stop stay in reach, and the
        // canvas keeps clear of it (data-tests-recording). A phone's sheet or a narrow drawer
        // would cover the form, so there it folds as before and the bar keeps Stop recording.
        const recordingHere = this.activePanel === "tests" && !this.phone && !this.narrow && this.testsPanelRecording();
        if (this.activePanel !== undefined && !recordingHere) {
          this.enteringTry = true;
          try {
            this.setPanel(undefined);
          } finally {
            this.enteringTry = false;
          }
        }
      } else {
        // Back to editing ends a showing the Tests panel handed the canvas; the canvas ends its own, this is the shell's say.
        this.showScenarioOnCanvas(undefined);
        const before = this.panelBeforeTrying;
        this.panelBeforeTrying = undefined;
        if (before !== undefined && this.activePanel === undefined && !this.phone) {
          this.setPanel(before);
        }
      }
      this.syncPhone();
    });
    // A surface's own editor up as a sheet on a phone: the shell dims and stills the bars.
    listen(this.rootNode, "builder-sheet-change", (event) => {
      const surface = event.target as Element | null;
      if (!surface) {
        return;
      }
      if ((event as CustomEvent<{ open: boolean }>).detail?.open === true) {
        this.surfaceSheets.add(surface);
      } else {
        this.surfaceSheets.delete(surface);
      }
      this.syncPhone();
    });
    // Try it's results sheet asks to go (its close, a problem's Go to).
    listen(this.rootNode, "canvas-results-close", () => this.setResults(false));
    // Its scrim is drawn inside the canvas, over the form: a tap anywhere but on the sheet puts the sheet away.
    this.canvasEl.addEventListener(
      "click",
      (event) => {
        if (this.resultsOpen && !event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-try-panel"))) {
          event.stopPropagation();
          this.closeSheet();
        }
      },
      true
    );
    // Working on the form (a click on the canvas or a component's handle) puts away a palette the shell opened.
    this.canvasEl.addEventListener("click", () => this.dismissAutoPalette());
    // The canvas's Enter and the selection bar's Add logic open the inspector.
    listen(this.rootNode, "canvas-edit-selection", () => {
      this.openInspector();
      this.propertiesEl.focusFirstField();
    });
    listen(this.rootNode, "canvas-add-logic", () => {
      this.openInspector();
      this.propertiesEl.inspectorTab = "rules";
      this.propertiesEl.focusFirstField();
    });

    // The sheet's edge being dragged: the readout follows it live, before the width is committed.
    listen(this.rootNode, "canvas-sheet-resize", (event) => {
      const width = (event as CustomEvent<{ width: number }>).detail?.width;
      const readout = this.rootNode.querySelector<HTMLElement>("[data-width-readout]");
      if (readout && typeof width === "number") {
        readout.hidden = false;
        readout.textContent = `${width}px`;
      }
    });

    // Collapse state of the properties panel -> the wrapper.
    listen(this.rootNode, "panel-toggle", (event) => {
      const source = (event.composedPath()[0] as HTMLElement)?.closest?.(DATUM_BUILDER_PROPERTIES_TAG);
      if (source) {
        this.wrapEl.toggleAttribute("data-props-collapsed", this.propertiesEl.collapsed);
        // Narrow: the inspector opening as a drawer puts the side column's drawer away.
        if (!this.propertiesEl.collapsed) {
          this.yieldedProps = false;
        }
        if ((this.narrow || this.medium) && !this.propertiesEl.collapsed && this.activePanel !== undefined) {
          this.setPanel(undefined);
        }
        this.savePanels();
      }
    });

    // Resizers.
    listen(this.rootNode, "mousedown", (event) => {
      const target = event.target as HTMLElement;
      const kind = target.dataset?.resizer;
      if (kind !== "side" && kind !== "props") {
        return;
      }
      const varName = kind === "side" ? "--db-side-w" : "--db-props-w";
      const measured = (kind === "side" ? this.rootNode.querySelector<HTMLElement>("[data-side]") : this.propertiesEl)?.getBoundingClientRect?.().width;
      const current =
        measured && measured > 0
          ? measured
          : parseInt(getComputedStyle(this.wrapEl).getPropertyValue(varName), 10) || (kind === "side" ? 240 : 300);
      this.drag = { kind, startX: (event as MouseEvent).clientX, startW: current };
      this.wrapEl.toggleAttribute("data-resizing", true);
      event.preventDefault();
    });

    /*
     * Keeps a builder drag "live" everywhere inside the shell.
     *
     * A `dragover` that does not `preventDefault()` means "cannot drop here", and the browser
     * answers by replacing the copy badge with the no-entry cursor. Only the canvas has real
     * drop targets, so a palette drag would lose its green "+" the moment it left the
     * palette button — before it had gone anywhere. Accepting the drag at the wrapper keeps
     * the badge for the whole gesture; the canvas still decides where anything actually lands,
     * and a drop that never reached it simply does nothing.
     */
    listen(this.rootNode, "dragover", (event) => {
      const dragEvent = event as DragEvent;
      const transfer = dragEvent.dataTransfer;
      if (!transfer || !Array.from(transfer.types ?? []).includes(BUILDER_DRAG_MIME_TYPE)) {
        return;
      }
      dragEvent.preventDefault();
      transfer.dropEffect = transfer.effectAllowed === "copy" ? "copy" : "move";
    });
    // Since the wrapper accepts the drag, it must also swallow a drop that lands on its own
    // chrome — an unhandled drop is a navigation in some browsers.
    listen(this.rootNode, "drop", (event) => event.preventDefault());

    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  }

  /**
   * The divider between the leading controls and undo/redo shows only when there is
   * something before it: the file actions, or whatever the host slotted.
   */
  private syncHostSeparator(): void {
    const slot = this.rootNode.querySelector<HTMLSlotElement>('slot[name="toolbar-start"]');
    const sep = this.rootNode.querySelector<HTMLElement>("[data-host-sep]");
    if (!slot || !sep) {
      return;
    }
    const slotted = slot
      .assignedNodes({ flatten: true })
      .some((node) => node.nodeType === Node.ELEMENT_NODE || (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""));
    sep.hidden = !slotted;
  }

  // --- the bar's file actions ---------------------------------------

  /** Which of the file actions the host supplied: each has a button on the bar, the rest none. */
  private suppliedFileActions(): Record<BuilderFileActionDetail["action"], boolean> {
    const actions = this.fileActionsValue;
    return {
      new: typeof actions?.new === "function",
      open: typeof actions?.open === "function",
      download: typeof actions?.download === "function",
      save: typeof actions?.save === "function"
    };
  }

  private hasFileActions(): boolean {
    const supplied = this.suppliedFileActions();
    return supplied.new || supplied.open || supplied.download || supplied.save;
  }

  /** Shows a button for each file action supplied, and the group only with one; a group put away takes its message and its question with it. */
  private syncFileActions(): void {
    const group = this.rootNode.querySelector<HTMLElement>("[data-file-actions]");
    if (!group) {
      return;
    }
    const supplied = this.suppliedFileActions();
    const show = (selector: string, on: boolean): void => {
      const button = group.querySelector<HTMLElement>(selector);
      if (button) {
        button.hidden = !on;
      }
    };
    show("[data-file-new]", supplied.new);
    show("[data-file-open]", supplied.open);
    show("[data-file-download]", supplied.download);
    show("[data-file-save]", supplied.save);
    // A rule between Save and the rest, only when there is a rest.
    show("[data-file-save-sep]", supplied.save && (supplied.new || supplied.open || supplied.download));
    const label = group.querySelector<HTMLElement>("[data-file-save] .file-item-label");
    if (label) {
      label.textContent = this.saving ? this.words.text("shell.file.saving") : this.fileActionsValue?.saveLabel?.trim() || this.words.text("shell.file.save");
    }
    const key = group.querySelector<HTMLElement>("[data-file-save-key]");
    if (key) {
      key.textContent = isApplePlatform() ? "⌘S" : "Ctrl+S";
    }
    // Dark mode keeps the menu on the bar even when the host supplies no file action.
    const schemeToggle = this.schemeToggleOffered();
    show("[data-file-scheme]", schemeToggle);
    show("[data-file-scheme-sep]", schemeToggle && this.hasFileActions());
    // The item names the scheme it switches to: "Light mode" under a sun while dark is on.
    const dark = this.scheme === "dark";
    const schemeLabel = group.querySelector<HTMLElement>("[data-file-scheme-label]");
    if (schemeLabel) {
      schemeLabel.textContent = this.words.text(dark ? "shell.menu.lightMode" : "shell.menu.darkMode");
    }
    show("[data-file-scheme-moon]", !dark);
    show("[data-file-scheme-sun]", dark);
    group.hidden = !this.hasFileActions() && !schemeToggle;
    if (group.hidden) {
      this.showFileError(undefined);
      this.closeFileConfirm();
      this.closeFileMenu();
    }
    this.syncHostSeparator();
  }

  // The file menu: a menu button, its items roved by the arrows as the document menu's are.

  private fileMenuEl(): HTMLElement | null {
    return this.rootNode.querySelector<HTMLElement>("[data-file-menu-list]");
  }

  private fileMenuItems(): HTMLElement[] {
    return [...(this.fileMenuEl()?.querySelectorAll<HTMLElement>("[role=menuitem]:not([hidden]):not([disabled])") ?? [])];
  }

  private openFileMenu(focus: "first" | "last" | "none" = "first"): void {
    const menu = this.fileMenuEl();
    if (!menu) {
      return;
    }
    this.closeDocumentMenu();
    menu.hidden = false;
    this.rootNode.querySelector<HTMLElement>("[data-file-menu]")?.setAttribute("aria-expanded", "true");
    window.addEventListener("click", this.onFileMenuOutside);
    const items = this.fileMenuItems();
    if (focus !== "none") {
      (focus === "first" ? items[0] : items.at(-1))?.focus();
    }
  }

  private closeFileMenu(focusToggle = false): void {
    const menu = this.fileMenuEl();
    if (!menu || menu.hidden) {
      return;
    }
    menu.hidden = true;
    window.removeEventListener("click", this.onFileMenuOutside);
    const toggle = this.rootNode.querySelector<HTMLElement>("[data-file-menu]");
    toggle?.setAttribute("aria-expanded", "false");
    if (focusToggle) {
      toggle?.focus();
    }
  }

  /** The menu's keys: the arrows, Home and End walk the items; Escape and Tab put it away. */
  private onFileMenuKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const menu = this.fileMenuEl();
    if (!menu) {
      return;
    }
    if (target?.dataset?.fileMenu !== undefined) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openFileMenu(event.key === "ArrowDown" ? "first" : "last");
      }
      return;
    }
    if (menu.hidden || !menu.contains(target)) {
      return;
    }
    const items = this.fileMenuItems();
    const index = items.indexOf(target as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeFileMenu(true);
    } else if (event.key === "Tab") {
      this.closeFileMenu();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length > 0) {
      event.preventDefault();
      const next =
        event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  /**
   * Save: past the unsaved-edits guard (an edit still in a panel is not in the form yet), the
   * host's save. One at a time: while a save the host returned is pending, the item says
   * "Saving…" and another is not started.
   */
  private fileSave(): void {
    const save = this.fileActionsValue?.save;
    if (typeof save !== "function" || this.saving) {
      return;
    }
    this.activeController.requestLeave(() => {
      void this.runSave();
    });
  }

  /**
   * The host's save itself, past whatever guard its caller applied: the person's {@link fileSave}
   * (behind the unsaved-edits prompt) and an assistant's {@link requestSave} (which never raises
   * one) share it, so both go through the one "Saving…" latch, mark the languages saved, tell the
   * host (`builder-file-action`) and show a failure beside the File menu alike. Answers how it
   * ended; the person's path ignores the answer. `trigger` reaches the host's save and the event.
   */
  private runSave(trigger?: "agent"): Promise<BuilderSaveOutcome> {
    const run = this.fileActionsValue?.save;
    if (typeof run !== "function") {
      return Promise.resolve({ status: "no-save" });
    }
    if (this.saving) {
      return Promise.resolve({ status: "busy" });
    }
    this.flushPrintWrites();
    let result: void | Promise<void>;
    const localeChanges = this.ctrl.localeChangesSinceSave();
    const changed = localeChanges.removed.length > 0 || localeChanges.renamed.length > 0;
    const asked = trigger === undefined ? {} : { trigger };
    try {
      result = run({ localeChanges, ...asked });
    } catch (error) {
      return Promise.resolve(this.saveFailed(error));
    }
    const saved = (): BuilderSaveOutcome => {
      this.fileActionDone({ action: "save", ...(changed ? { localeChanges } : {}), ...asked });
      return { status: "saved", ...(changed ? { localeChanges } : {}) };
    };
    if (!(result instanceof Promise)) {
      this.ctrl.markLocalesSaved();
      this.localeTargets = new Map();
      return Promise.resolve(saved());
    }
    // The languages the save was handed are the baseline at once: one renamed or removed while it
    // is pending is the next save's to hand over. A failure puts the baseline back, that move on top.
    const unsaved = this.ctrl.markLocalesSaving();
    this.localeTargets = new Map();
    this.setSaving(true, trigger);
    return result.then(
      () => {
        this.setSaving(false);
        return saved();
      },
      (error: unknown) => {
        this.setSaving(false);
        unsaved();
        this.localeTargets = new Map(this.ctrl.localeChangesSinceSave().renamed.map((entry) => [entry.from, entry.to]));
        return this.saveFailed(error);
      }
    );
  }

  /**
   * Print holds a typed value for a moment before it writes it to the form and has no leave guard to
   * ask first, so a file action that reads or replaces the form (Save by key, an assistant's save,
   * Download, New, Open) lets it write now: the form it reads is the one the author sees.
   */
  private flushPrintWrites(): void {
    this.printEl?.flushWrites();
  }

  /** A save the host threw or rejected: its words beside the File menu, and in the answer. */
  private saveFailed(error: unknown): BuilderSaveOutcome {
    const message = errorMessage(error);
    this.showFileError(this.words.text("shell.file.saveFailed", { reason: message }), "[data-file-menu]");
    return { status: "failed", message };
  }

  private saving = false;

  /**
   * Save's item while the host's save is pending: busy, and named so. An assistant's save
   * (`trigger: "agent"`) never disables the item while the person's focus is on it (an
   * assistant does not take the person's focus): a disabled button drops focus to the page, so it
   * is `aria-disabled` then, which says the same, and nothing starts a second save while `saving`
   * ({@link fileSave} and {@link runSave} both check it). The person's own Save has put the menu
   * away and moved focus to its button before this runs.
   */
  private setSaving(on: boolean, trigger?: "agent"): void {
    this.saving = on;
    const item = this.rootNode.querySelector<HTMLButtonElement>("[data-file-save]");
    if (item) {
      const focused = on && trigger === "agent" && this.rootNode.activeElement === item;
      item.toggleAttribute("aria-busy", on);
      item.disabled = on && !focused;
      if (focused) {
        item.setAttribute("aria-disabled", "true");
      } else {
        item.removeAttribute("aria-disabled");
      }
      const label = item.querySelector<HTMLElement>(".file-item-label");
      if (label) {
        label.textContent = on ? this.words.text("shell.file.saving") : this.fileActionsValue?.saveLabel?.trim() || this.words.text("shell.file.save");
      }
    }
  }

  /** Binds the file actions' controls in freshly built markup: the group's buttons, the file picker, the confirmation. */
  private wireFileActions(): void {
    // Fresh markup: a question the old markup was asking is gone with it.
    this.fileConfirmRun = undefined;
    this.fileConfirmOpener = undefined;
    const group = this.rootNode.querySelector<HTMLElement>("[data-file-actions]");
    group?.addEventListener("click", (event) => this.onFileActionsClick(event));
    group?.addEventListener("keydown", (event) => this.onFileMenuKeyDown(event as KeyboardEvent));
    const input = this.rootNode.querySelector<HTMLInputElement>("[data-file-input]");
    input?.addEventListener("change", () => this.onFileChosen(input));
    const dialog = this.fileConfirmEl();
    if (!dialog) {
      return;
    }
    dialog.addEventListener("click", (event) => {
      const path = event.composedPath() as HTMLElement[];
      if (path.some((el) => el?.dataset?.fileConfirmOk !== undefined)) {
        this.answerFileConfirm(true);
      } else if (path.some((el) => el?.dataset?.fileConfirmCancel !== undefined)) {
        this.answerFileConfirm(false);
      }
    });
    // Escape is Cancel: the modal dialog's own cancel, or the key itself where it is only open.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.answerFileConfirm(false);
    });
    dialog.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.answerFileConfirm(false);
      }
    });
  }

  /** A click in the file actions' group: a file button, or the message's Dismiss. Matched along the path, like the bar's other buttons. */
  private onFileActionsClick(event: Event): void {
    const path = event.composedPath() as HTMLElement[];
    const has = (key: string): HTMLElement | undefined => path.find((el) => el?.dataset?.[key] !== undefined);
    if (has("fileMenu")) {
      if (this.fileMenuEl()?.hidden === false) {
        this.closeFileMenu();
      } else {
        this.openFileMenu();
      }
      return;
    }
    // An item puts the menu away first; focus goes back to the menu's button, where a
    // confirmation also hands it back.
    if (path.some((el) => el?.getAttribute?.("role") === "menuitem")) {
      this.closeFileMenu(true);
    }
    if (has("fileScheme")) {
      this.toggleScheme();
      return;
    }
    if (has("fileSave")) {
      this.fileSave();
      return;
    }
    if (has("fileErrorDismiss")) {
      const source = this.fileErrorSource;
      this.showFileError(undefined);
      // The button that had focus is gone with the message: the file button it was about takes
      // it (Open for a refused file, Download for "not available"), else the first one shown.
      const about = source ? this.rootNode.querySelector<HTMLElement>(source) : null;
      const target =
        // An item counts only while the menu around it is open: focus cannot land in a shut menu.
        about?.isConnected && about.closest("[hidden]") === null
          ? about
          : this.rootNode.querySelector<HTMLElement>("[data-file-actions] .bar-btn:not([hidden]):not([data-file-error-dismiss])");
      target?.focus();
      return;
    }
    if (has("fileNew")) {
      this.fileNew(this.rootNode.querySelector<HTMLElement>("[data-file-menu]") ?? has("fileNew")!);
      return;
    }
    if (has("fileOpen")) {
      this.fileOpen();
      return;
    }
    if (has("fileDownload")) {
      this.fileDownload();
    }
  }

  /**
   * New: past the unsaved-edits guard, the host's empty form in place of this one — asked
   * first, unless the form has nothing to lose (see {@link formIsEmpty} and the host's
   * `isEmpty`).
   */
  private fileNew(opener: HTMLElement): void {
    if (typeof this.fileActionsValue?.new !== "function") {
      return;
    }
    this.showFileError(undefined);
    this.activeController.requestLeave(() => {
      this.flushPrintWrites();
      const run = (): void => {
        const action = this.fileActionsValue?.new;
        if (typeof action !== "function") {
          return;
        }
        action();
        this.fileActionDone({ action: "new" });
      };
      // Asked after the guard: a Save there may have been the form's first component. The host
      // has the last word on what else the form holds (PDF layouts, journeys).
      if (this.formIsEmpty() && (this.fileActionsValue?.isEmpty?.() ?? true)) {
        run();
        return;
      }
      this.askFileConfirm(
        {
          title: this.words.text("shell.file.new"),
          message: this.words.text("shell.file.newConfirm.message"),
          ok: this.words.text("shell.file.newConfirm.ok"),
          opener
        },
        run
      );
    });
  }

  /**
   * Whether the form as committed has nothing a New would lose: no component, nothing set on
   * the form itself (title, header and footer), no languages. A New then asks nothing. A setting
   * cleared on the Form panel can stay behind as a key with no value, which is nothing set.
   * The one Submit button File > New seeds, untouched, is not a component to lose: a New straight
   * after a New asks nothing (the seed is the same form).
   */
  private formIsEmpty(): boolean {
    const root = this.ctrl.snapshot();
    return (
      Object.values(root.children ?? {}).every((group) => (group ?? []).every(isUntouchedSeededSubmit)) &&
      Object.values(root.configuration ?? {}).every((value) => value === undefined) &&
      this.ctrl.localization() === undefined
    );
  }

  /** Open: the file picker, opened here, inside the author's click — a picker opens on a gesture only. */
  private fileOpen(): void {
    if (typeof this.fileActionsValue?.open !== "function") {
      return;
    }
    this.rootNode.querySelector<HTMLInputElement>("[data-file-input]")?.click();
  }

  private onFileChosen(input: HTMLInputElement): void {
    const file = input.files?.[0];
    // Cleared so the same file can be chosen again (after fixing it): a file input reports a
    // change only when its value changes.
    input.value = "";
    if (file) {
      void this.openFile(file);
    }
  }

  /**
   * Reads the chosen file and hands it to the host to check. A refusal shows on the bar; a
   * file the host accepts goes, past the unsaved-edits guard and a confirmation, in place of
   * this form.
   */
  private async openFile(file: File): Promise<void> {
    const name = file.name;
    // A refusal of an earlier file is about that file, not this one: it goes as soon as another is chosen.
    this.showFileError(undefined);
    // Measured before it is read: a file past the cap is never read into memory, let alone parsed.
    const tooLarge = definitionSizeProblem(file.size, this.maxDefinitionBytesValue);
    if (tooLarge !== undefined) {
      this.showFileError(this.words.text("shell.file.readFailed", { name, reason: tooLarge }), "[data-file-open]");
      return;
    }
    let text: string;
    try {
      text = await readFileText(file, this.words.text("shell.file.unreadable"));
    } catch (error) {
      this.showFileError(this.words.text("shell.file.readFailed", { name, reason: errorMessage(error) }), "[data-file-open]");
      return;
    }
    const open = this.fileActionsValue?.open;
    if (typeof open !== "function") {
      return;
    }
    let apply: () => void;
    try {
      apply = await open({ name, text });
    } catch (error) {
      this.showFileError(this.words.text("shell.file.openFailed", { name, reason: errorMessage(error) }), "[data-file-open]");
      return;
    }
    if (typeof apply !== "function") {
      return;
    }
    const opener = this.rootNode.querySelector<HTMLElement>("[data-file-menu]") ?? undefined;
    this.activeController.requestLeave(() => {
      this.flushPrintWrites();
      this.askFileConfirm(
        { title: this.words.text("shell.file.openConfirm.title"), message: this.words.text("shell.file.openConfirm.message", { name }), ok: this.words.text("shell.file.openConfirm.ok"), opener },
        () => {
          try {
            apply();
          } catch (error) {
            this.showFileError(this.words.text("shell.file.openFailed", { name, reason: errorMessage(error) }), "[data-file-open]");
            return;
          }
          this.fileActionDone({ action: "open", name });
        }
      );
    });
  }

  /** Download: past the unsaved-edits guard (an edit still in the inspector is not in the file yet), the host's file as a download. */
  private fileDownload(): void {
    if (typeof this.fileActionsValue?.download !== "function") {
      return;
    }
    this.activeController.requestLeave(() => {
      const download = this.fileActionsValue?.download;
      if (typeof download !== "function") {
        return;
      }
      this.flushPrintWrites();
      if (typeof URL.createObjectURL !== "function") {
        this.showFileError(this.words.text("shell.file.noDownload"), "[data-file-download]");
        return;
      }
      const file = download();
      const url = URL.createObjectURL(new Blob([file.text], { type: file.type ?? "application/json" }));
      const anchor = this.ownerDocument.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.hidden = true;
      this.rootNode.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoked a moment later rather than at once: a browser may start reading the blob only after the click.
      setTimeout(() => {
        if (typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(url);
        }
      }, 1000);
      this.fileActionDone({ action: "download", name: file.name });
    });
  }

  /**
   * A file action completed: any old message goes, and the host hears which one. After an
   * assistant's save the message stays while the person's focus is in it (its Dismiss): hiding it
   * would drop that focus to the page, and their Dismiss puts it away.
   */
  private fileActionDone(detail: BuilderFileActionDetail): void {
    const box = this.rootNode.querySelector<HTMLElement>("[data-file-error]");
    if (detail.trigger !== "agent" || !box?.contains(this.rootNode.activeElement)) {
      this.showFileError(undefined);
    }
    this.dispatchEvent(
      new CustomEvent<BuilderFileActionDetail>("builder-file-action", { detail, bubbles: true, composed: true })
    );
  }

  /**
   * Shows a message beside the file actions (replacing any before it), or with `undefined` puts
   * it away. `source` is the selector of the file button it is about, which Dismiss hands focus
   * back to. The line is cut short on the bar, so its title carries the whole of it; the alert
   * reads the whole of it either way.
   */
  private showFileError(message: string | undefined, source?: string): void {
    this.fileErrorSource = message === undefined ? undefined : source;
    const box = this.rootNode.querySelector<HTMLElement>("[data-file-error]");
    const text = box?.querySelector<HTMLElement>("[data-file-error-message]");
    if (!box || !text) {
      return;
    }
    box.hidden = message === undefined;
    text.textContent = message ?? "";
    if (message === undefined) {
      text.removeAttribute("title");
    } else {
      text.title = message;
    }
  }

  private fileConfirmEl(): HTMLDialogElement | null {
    return this.rootNode.querySelector<HTMLDialogElement>("[data-file-confirm]");
  }

  /**
   * Asks before a file action replaces the form, in a modal dialog in the look of the panels'
   * unsaved-changes prompt; `run` runs on its OK. Focus starts on Cancel: the destructive
   * answer takes a deliberate move. A newer question replaces one still up.
   */
  private askFileConfirm(ask: { title: string; message: string; ok: string; opener?: HTMLElement | undefined }, run: () => void): void {
    const dialog = this.fileConfirmEl();
    if (!dialog) {
      return;
    }
    this.closeFileConfirm();
    const title = dialog.querySelector<HTMLElement>("[data-file-confirm-title]");
    const message = dialog.querySelector<HTMLElement>("[data-file-confirm-message]");
    const ok = dialog.querySelector<HTMLElement>("[data-file-confirm-ok]");
    if (title) {
      title.textContent = ask.title;
    }
    if (message) {
      message.textContent = ask.message;
    }
    if (ok) {
      ok.textContent = ask.ok;
    }
    this.fileConfirmRun = run;
    this.fileConfirmOpener = ask.opener;
    let modal = false;
    if (typeof dialog.showModal === "function") {
      try {
        showBuilderModal(dialog);
        modal = true;
      } catch {
        modal = false;
      }
    }
    if (!modal) {
      // No modal dialogs here (a test DOM): open, and answered the same way.
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>("[data-file-confirm-cancel]")?.focus();
  }

  /** The confirmation's answer: it goes away, focus goes back to the button that asked, and OK runs the action. */
  private answerFileConfirm(ok: boolean): void {
    const run = this.fileConfirmRun;
    const opener = this.fileConfirmOpener;
    this.closeFileConfirm();
    if (!run) {
      return;
    }
    if (opener?.isConnected && !opener.hidden) {
      opener.focus();
    }
    if (ok) {
      run();
    }
  }

  private closeFileConfirm(): void {
    this.fileConfirmRun = undefined;
    this.fileConfirmOpener = undefined;
    const dialog = this.fileConfirmEl();
    if (!dialog) {
      return;
    }
    if (dialog.hasAttribute("open") && typeof dialog.close === "function") {
      try {
        dialog.close();
      } catch {
        // Closed below regardless.
      }
    }
    dialog.removeAttribute("open");
  }

  // --- the bar's controls -------------------------------------------

  /** Subscribes the bar to the controller on the page, so its controls follow that controller's state. */
  private bindBar(controller: BuilderController): void {
    this.unbindBar();
    // Both events: `select` reports a selection, while an add (or an undo that takes one
    // away) moves it as part of a change. The inspector's column follows either.
    this.barUnsub.push(
      controller.on("change", (event) => {
        // A live draft write (a keystroke in a panel box) moves neither the bar's controls nor
        // the inspector's column: they catch up with the plain change the box sends on blur.
        if (!event.live) {
          // Where the inspector edits first: an edit may have taken its subject away.
          this.syncInspection();
          this.syncBar();
          this.syncInspector();
        }
        // The form's tab is its title, which an edit on the Form panel moves.
        this.renderDocuments();
      })
    );
    this.barUnsub.push(
      controller.on("selection", () => {
        // Where the inspector edits first. This listener is the controller's first (the
        // bar is bound before the panels are pointed), so a move of the inspector to another
        // controller takes it off this one before its own listener would paint the wrong subject.
        this.syncInspection();
        this.syncBar();
        this.syncInspector();
      })
    );
  }

  private unbindBar(): void {
    for (const off of this.barUnsub) {
      off();
    }
    this.barUnsub = [];
  }

  /**
   * Repaints the bar's controls from the active controller: undo/redo enablement follows its
   * history, the width picker and readout the sheet (put away while the tree fixes the
   * width), the theme picker the host's themes (put away with none to pick from), the locale
   * switcher the form's locales (put away on another mode's tree, whose faces are built for
   * the host's locale), and the show-hidden toggle its state.
   */
  /** The View panel's Form chrome, from the form controller's preview chrome; the frame list from the theme on the canvas. */
  private syncPreviewChrome(): void {
    const controller = this.ctrl;
    const chrome = controller.previewChrome();
    const frame = this.rootNode.querySelector<HTMLSelectElement>("[data-preview-chrome-frame]");
    if (frame) {
      const frameId = typeof chrome?.frame === "string" ? chrome.frame : chrome?.frame?.id;
      const options = `<option value="">${escapeHtml(this.words.text("view.chrome.frameNone"))}</option>${controller
        .frameChoices()
        .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
        .join("")}`;
      if (frame.dataset.options !== options) {
        frame.innerHTML = options;
        frame.dataset.options = options;
      }
      frame.value = frameId ?? "";
    }
    const fixed = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-fixed]");
    if (fixed) {
      fixed.checked = typeof chrome?.frame === "object" && chrome.frame.fixed === true;
      fixed.disabled = !frame?.value;
    }
    const parts = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-parts]");
    if (parts) {
      parts.checked = chrome?.formChrome !== "exclude";
    }
    const switcher = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-switcher]");
    if (switcher) {
      switcher.checked = chrome?.formLanguageSwitcher !== false;
    }
  }

  /** The View panel's Form chrome, read back into the preview chrome: only what differs from the page's defaults is set. */
  private readPreviewChrome(): void {
    const frameId = this.rootNode.querySelector<HTMLSelectElement>("[data-preview-chrome-frame]")?.value ?? "";
    const fixed = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-fixed]")?.checked === true;
    const parts = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-parts]")?.checked !== false;
    const switcher = this.rootNode.querySelector<HTMLInputElement>("[data-preview-chrome-switcher]")?.checked !== false;
    const chrome: FormChromeConfiguration = {
      ...(frameId ? { frame: fixed ? { id: frameId, fixed: true } : frameId } : {}),
      ...(parts ? {} : { formChrome: "exclude" as const }),
      ...(switcher ? {} : { formLanguageSwitcher: false })
    };
    this.ctrl.setPreviewChrome(Object.keys(chrome).length > 0 ? chrome : undefined);
  }

  /**
   * The Settings panel's data sources: every source the form's choices name, the host's own and
   * the simulated ones, each saying where its list comes from, with a box to simulate one.
   */
  private syncSettingsSources(): void {
    const host = this.rootNode.querySelector<HTMLElement>("[data-settings-sources]");
    if (!host) {
      return;
    }
    const controller = this.ctrl;
    const named = new Set<string>();
    const walk = (node: ComponentNode): void => {
      const source = (node.configuration as { data?: { sourceId?: unknown } } | undefined)?.data?.sourceId;
      if (typeof source === "string" && source.trim()) {
        named.add(source.trim());
      }
      for (const children of Object.values(node.children ?? {})) {
        for (const child of children) {
          walk(child);
        }
      }
    };
    walk(controller.snapshot());
    const provided = new Set(controller.hostDataSourceIdList());
    const simulated = controller.simulatedDataSources();
    const ids = [...new Set([...named, ...provided, ...simulated.keys()])].sort((a, b) => a.localeCompare(b));
    const editing = this.editingSource && ids.includes(this.editingSource.id) ? this.editingSource : undefined;
    const signature = JSON.stringify([ids, [...provided], [...simulated.entries()], editing ? [editing.id, editing.error ?? null] : null]);
    if (signature === this.sourcesSignature) {
      return;
    }
    this.sourcesSignature = signature;
    if (ids.length === 0) {
      host.innerHTML = `<p class="view-note">${escapeHtml(this.words.text("settings.sources.none"))}</p>`;
      return;
    }
    host.innerHTML = `<ul class="source-list">${ids
      .map((id) => {
        const state = simulated.has(id) ? "simulated" : provided.has(id) ? "host" : "missing";
        const word = this.words.text(`settings.sources.state.${state}` as BuilderTextKey);
        const box =
          editing?.id === id
            ? `<textarea data-source-text aria-label="${escapeHtml(this.words.text("settings.sources.options", { id }))}" aria-describedby="source-format-${escapeHtml(id)}">${escapeHtml(editing.text)}</textarea>
              <p class="view-note" id="source-format-${escapeHtml(id)}">${escapeHtml(this.words.text("settings.sources.format"))}</p>
              ${editing.error ? `<p class="source-error" role="alert">${escapeHtml(editing.error)}</p>` : ""}
              <div class="source-actions"><button type="button" class="btn primary" data-source-apply>${escapeHtml(this.words.text("settings.sources.use"))}</button><button type="button" class="btn" data-source-cancel>${escapeHtml(this.words.text("settings.sources.cancel"))}</button></div>`
            : `<div class="source-actions"><button type="button" class="btn" data-source-edit>${escapeHtml(this.words.text(state === "simulated" ? "settings.sources.edit" : "settings.sources.simulate"))}</button>${
                state === "simulated" ? `<button type="button" class="btn" data-source-clear>${escapeHtml(this.words.text("settings.sources.clear"))}</button>` : ""
              }</div>`;
        return `<li class="source-item" data-source-id="${escapeHtml(id)}"><div class="source-head"><span class="source-id">${escapeHtml(id)}</span><span class="source-state" data-state="${state}">${escapeHtml(word)}</span></div>${box}</li>`;
      })
      .join("")}</ul>`;
    if (editing) {
      host.querySelector<HTMLTextAreaElement>("[data-source-text]")?.focus();
    }
  }

  /**
   * The Settings panel's Submitting in Try it, drawn from the form's controller. A box
   * whose text already says the value is left alone, so a focused one keeps its caret.
   */
  private syncTrySubmission(): void {
    const section = this.rootNode.querySelector<HTMLElement>("[data-settings-submit]");
    if (!section) {
      return;
    }
    const settings = this.ctrl.trySubmission();
    const read = (path: string): unknown => path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], settings);
    for (const control of section.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-try-setting]")) {
      const next = String(read(control.dataset.trySetting!) ?? "");
      if (control.value !== next) {
        control.value = next;
      }
    }
    for (const set of section.querySelectorAll<HTMLElement>("[data-try-placement]")) {
      const placement = read(set.dataset.tryPlacement!) as string[];
      for (const box of set.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        box.checked = placement.includes(box.value);
      }
    }
  }

  /** A Submitting in Try it control changed: its value goes to the form's controller. */
  private readTrySubmission(target: HTMLElement): void {
    const set = target.closest<HTMLElement>("[data-try-placement]");
    const path = set?.dataset.tryPlacement ?? target.dataset.trySetting;
    if (!path) {
      return;
    }
    let value: unknown;
    if (set) {
      value = [...set.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((box) => box.checked).map((box) => box.value);
      if ((value as string[]).length === 0) {
        // One end at least: the box just cleared stays ticked.
        (target as HTMLInputElement).checked = true;
        return;
      }
    } else {
      value = (target as HTMLInputElement).value;
    }
    const [head, key] = path.split(".");
    const update: TrySubmissionUpdate = key ? { [head!]: { [key]: value } } : { [head!]: value };
    this.ctrl.setTrySubmission(update);
    this.syncTrySubmission();
  }

  /**
   * The Settings panel's Host values, drawn from the form's controller: the box shows the values
   * in use, except while it is focused or holds a problem (what is typed stays until it is
   * applied), and the problem sits under it. The line saying the form reads host values shows
   * only when a rule or calculation does (a scan of the rules' text, redone when it changes).
   */
  private syncHostValues(): void {
    const section = this.rootNode.querySelector<HTMLElement>("[data-settings-host]");
    if (!section) {
      return;
    }
    const controller = this.ctrl;
    const box = section.querySelector<HTMLTextAreaElement>("[data-host-values]");
    if (box && this.hostValuesProblem === undefined && this.rootNode.activeElement !== box) {
      const context = controller.tryHostContext();
      const next = context === undefined ? "" : JSON.stringify(context, null, 2);
      let shown: unknown;
      try {
        shown = box.value.trim() === "" ? undefined : JSON.parse(box.value);
      } catch {
        shown = undefined;
      }
      // The box already says these values (as typed, however spaced): left alone, so a caret in it stays put.
      if (JSON.stringify(shown ?? null) !== JSON.stringify(context ?? null)) {
        box.value = next;
      }
    }
    const problem = section.querySelector<HTMLElement>("[data-host-problem]");
    if (problem) {
      const text = this.hostValuesProblem ?? "";
      if (problem.textContent !== text) {
        problem.textContent = text;
      }
      problem.hidden = text === "";
      box?.setAttribute("aria-invalid", text === "" ? "false" : "true");
    }
    const reads = section.querySelector<HTMLElement>("[data-settings-host-reads]");
    if (reads) {
      const rules: string[] = [];
      const walk = (node: ComponentNode): void => {
        if (node.rules !== undefined) {
          rules.push(JSON.stringify(node.rules));
        }
        for (const children of Object.values(node.children ?? {})) {
          for (const child of children) {
            walk(child);
          }
        }
      };
      walk(controller.snapshot());
      const signature = rules.join("\n");
      if (signature !== this.hostReadsSignature) {
        this.hostReadsSignature = signature;
        reads.hidden = !/\bhost\.[A-Za-z_]/.test(signature);
      }
    }
  }

  /**
   * The Host values box was changed (on blur, never per keystroke): empty
   * means none; a JSON object goes through `plainHostContext` (the page property's own rules) to
   * the controller; text that is not JSON, or JSON that is not an object, is said under the box
   * and the last good values stay in use. Never an edit of the form.
   */
  private readHostValues(box: HTMLTextAreaElement): void {
    const text = box.value.trim();
    if (text === "") {
      this.hostValuesProblem = undefined;
      this.ctrl.setTryHostContext(undefined);
      this.syncHostValues();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.hostValuesProblem = this.words.text("settings.host.problem.json", { reason: error instanceof Error ? error.message : String(error) });
      this.syncHostValues();
      return;
    }
    const kept = plainHostContext(parsed);
    if (kept.context === undefined) {
      this.hostValuesProblem = this.words.text("settings.host.problem.object");
      this.syncHostValues();
      return;
    }
    // Parsed JSON holds only what JSON carries, but the depth and size bounds still apply: what they leave out is named.
    this.hostValuesProblem = kept.problems.length > 0 ? this.words.text("settings.host.problem.left", { details: kept.problems.join("; ") }) : undefined;
    this.ctrl.setTryHostContext(kept.context);
    this.syncHostValues();
  }

  /** A Settings panel source button: open the box, use its list, cancel, or stop simulating. */
  private runSourceAction(button: HTMLElement): void {
    const item = button.closest<HTMLElement>("[data-source-id]");
    const id = item?.dataset.sourceId;
    if (!id) {
      return;
    }
    const controller = this.ctrl;
    if (button.dataset.sourceEdit !== undefined) {
      const items = controller.simulatedDataSources().get(id) ?? [];
      // Lines hold plain labels; a localized one needs the JSON form to survive an edit.
      const plain = items.every((entry) => typeof entry.label === "string");
      this.editingSource = {
        id,
        text: plain
          ? items.map((entry) => (entry.label === entry.value ? entry.value : `${entry.value} | ${entry.label as string}`)).join("\n")
          : JSON.stringify(items, null, 2)
      };
    } else if (button.dataset.sourceCancel !== undefined) {
      this.editingSource = undefined;
    } else if (button.dataset.sourceClear !== undefined) {
      this.editingSource = undefined;
      controller.setSimulatedDataSource(id, undefined);
    } else if (button.dataset.sourceApply !== undefined) {
      const text = item.querySelector<HTMLTextAreaElement>("[data-source-text]")?.value ?? "";
      const parsed = parseSimulatedOptions(text, this.words);
      if (typeof parsed === "string") {
        this.editingSource = { id, text, error: parsed };
      } else {
        this.editingSource = undefined;
        controller.setSimulatedDataSource(id, parsed);
      }
    }
    this.sourcesSignature = undefined;
    this.syncSettingsSources();
    if (!this.editingSource) {
      const row = [...this.rootNode.querySelectorAll<HTMLElement>("[data-source-id]")].find((entry) => entry.dataset.sourceId === id);
      row?.querySelector<HTMLElement>("[data-source-edit]")?.focus();
    }
  }

  /** The bar's Undo and Redo, enabled as {@link canHistoryStep} answers (the mode's history first). */
  private syncHistoryButtons(): void {
    const root = this.rootNode;
    const undo = root.querySelector<HTMLButtonElement>("[data-undo]");
    if (undo) {
      undo.disabled = !this.canHistoryStep("undo");
    }
    const redo = root.querySelector<HTMLButtonElement>("[data-redo]");
    if (redo) {
      redo.disabled = !this.canHistoryStep("redo");
    }
  }

  /** The mode whose `subscribeHistory` is heard, and the unsubscribe. */
  private historySubscription: { mode: BuilderMode; off: () => void } | undefined;

  /**
   * Hears the mode on the page say its history moved, so the bar's Undo and Redo follow a step
   * made on a controller the bar is not bound to (a form field edited from a journey's Step
   * view); the previous mode is no longer heard.
   */
  private listenModeHistory(): void {
    const mode = this.activeMode;
    if (this.historySubscription?.mode === mode) {
      return;
    }
    this.historySubscription?.off();
    this.historySubscription = undefined;
    const off = mode.subscribeHistory?.(() => {
      if (this.activeMode === mode && this.wrapEl) {
        this.syncHistoryButtons();
      }
    });
    if (off) {
      this.historySubscription = { mode, off };
    }
  }

  private syncBar(): void {
    const root = this.rootNode;
    if (!this.wrapEl) {
      return;
    }
    const controller = this.activeMode.controller;
    const primary = this.activeMode.id === PRIMARY_BUILDER_MODE;
    this.syncHistoryButtons();
    this.syncPreviewChrome();
    this.syncSettingsSources();
    this.syncTrySubmission();
    this.syncHostValues();

    const fixedWidth = controller.sheetWidth(controller.previewSnapshot());
    const widthSelect = root.querySelector<HTMLSelectElement>("[data-preview-width]");
    const widthField = root.querySelector<HTMLElement>("[data-width-field]");
    if (widthSelect && widthField) {
      // A width no device entry matches — one dragged out by hand, or set by the host — shows
      // as the Custom entry; the readout beside the select carries the number.
      const value = String(controller.previewWidth() ?? "");
      const match = Array.from(widthSelect.options).some((option) => option.value === value);
      widthSelect.value = match ? value : "custom";
      widthField.hidden = fixedWidth !== undefined;
      // The picker is an icon button, so the tooltip is where the current choice reads out.
      const label = widthSelect.selectedOptions[0]?.textContent;
      widthField.title = label ? this.words.text("view.width.tip", { choice: label }) : this.words.text("view.width.label");
    }
    const readout = root.querySelector<HTMLElement>("[data-width-readout]");
    if (readout) {
      const width = fixedWidth === undefined ? controller.previewWidth() : undefined;
      readout.hidden = width === undefined;
      readout.textContent = width === undefined ? "" : `${width}px`;
    }

    // The binding picker appears only when the host offered bindings to pick from — a
    // control with one entry is not a choice.
    const bindingField = root.querySelector<HTMLElement>("[data-binding-field]");
    const bindingSelect = root.querySelector<HTMLSelectElement>("[data-binding]");
    if (bindingField && bindingSelect) {
      // Each entry is named as the canvas draws it under the builder's scheme: a dark builder
      // lists a binding under its dark variant's name, so the picker says what shows.
      const choices = controller.bindingChoices();
      // Also away without the `binding-picker` feature: `binding` still sets the binding itself.
      bindingField.hidden = choices.length < 2 || !this.featureEnabled("binding-picker");
      const markup = choices
        .map((choice) => `<option value="${escapeHtml(choice.id)}">${escapeHtml(choice.label)}</option>`)
        .join("");
      if (bindingSelect.innerHTML !== markup) {
        bindingSelect.innerHTML = markup;
      }
      // With no entry for what the canvas draws with (a host's binding the picker does not
      // list) none claims it (-1): choosing any one is a change.
      bindingSelect.selectedIndex = choices.findIndex((choice) => choice.selected);
      const label = bindingSelect.selectedOptions[0]?.textContent;
      bindingField.title = label ? this.words.text("view.theme.tip", { choice: label }) : this.words.text("view.theme.name");
    }

    const localeSelect = root.querySelector<DatumLocaleSelectElement>("[data-locale-select]");
    if (localeSelect) {
      // The switcher moves the form's locale. On another mode's tree (a PDF layout, whose
      // faces and previews are built for the host's locale) it would move only that
      // controller's, half the picture, so it stays put away there: an empty list hides it.
      localeSelect.locales = primary ? this.settingsLocaleOptions(controller) : [];
      localeSelect.value = controller.currentLocale();
      // Languages keeps the bar's language for itself; a removal moves it, so follow.
      if (primary && this.languagesEl && this.languagesEl.locale !== controller.currentLocale()) {
        this.languagesEl.locale = controller.currentLocale();
      }
      // Settings says why there is no menu: a form in one language, or another mode's tree.
      const none = root.querySelector<HTMLElement>("[data-settings-language-none]");
      if (none) {
        none.hidden = localeSelect.locales.length > 0;
        none.textContent = this.words.text(primary ? "settings.language.none" : "settings.language.noneDesigner");
      }
    }

    const showHidden = root.querySelector<HTMLInputElement>("[data-show-hidden]");
    if (showHidden) {
      showHidden.checked = controller.showHiddenComponents();
    }
  }

  /**
   * The Settings language list: the form's supported languages, and, when the form's own
   * language (`defaultLocale`, else "en") is not one of them, that language first as "Form
   * default (English)". A form with a French translation alone declares only "fr", and the
   * select the canvas shows English in would otherwise be blank, or have no way back from French.
   * Empty while the form declares no other language (the section says so instead).
   */
  private settingsLocaleOptions(controller: BuilderController): BuilderLocaleOption[] {
    const options = controller.localeOptions();
    if (options.length === 0) {
      return options;
    }
    const fallback = declaredDefaultLocale(controller.localization()) ?? "en";
    const lead = options.some((option) => option.code === fallback)
      ? []
      : [{ code: fallback, label: this.words.text("settings.language.default", { language: localeDisplayName(fallback) }) }];
    return [...lead, ...options];
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const controller = this.activeMode.controller;
    if (target?.closest?.("[data-preview-chrome]")) {
      this.readPreviewChrome();
      return;
    }
    if (target?.dataset?.showHidden !== undefined) {
      controller.setShowHiddenComponents((target as unknown as HTMLInputElement).checked);
      return;
    }
    if (target?.closest?.("[data-settings-submit]")) {
      this.readTrySubmission(target);
      return;
    }
    if (target?.dataset?.hostValues !== undefined) {
      this.readHostValues(target as unknown as HTMLTextAreaElement);
      return;
    }
    if (target?.dataset?.previewWidth !== undefined) {
      // "custom" is a display state, not a choice — it is selected programmatically when the
      // width matches no device, and choosing it by hand would mean nothing. Nor is there a
      // choice to make while the tree fixes the width (the picker is hidden then).
      if (target.value === "custom" || controller.sheetWidth() !== undefined) {
        return;
      }
      controller.setPreviewWidth(target.value === "" ? undefined : Number(target.value));
      return;
    }
    if (target?.dataset?.binding !== undefined) {
      this.pickBinding(this.ctrl, target.value);
    }
  }

  /**
   * The View panel's binding picker, chosen: the form's controller draws the canvas with the
   * binding (`undefined`: the host's own, else Datum's), and the host hears which (`""` for
   * that). Shared with {@link setBindingForAgent}. Nothing is written into the form or its PDF
   * layouts: the choice is how the canvas shows the form.
   */
  private pickBinding(controller: BuilderController, id: string | undefined): void {
    controller.setBindingId(id);
    /*
     * The canvas redraws itself off the controller's change event; this tells the *host* which
     * binding was picked, so it can draw the live form with the same one. Composed so it
     * crosses the shadow boundary and can be listened for on <datum-builder>.
     */
    this.dispatchEvent(
      new CustomEvent<{ bindingId: string }>("builder-binding-change", {
        detail: { bindingId: id ?? "" },
        bubbles: true,
        composed: true
      })
    );
  }

  private onClick(event: Event): void {
    const path = event.composedPath() as HTMLElement[];
    const has = (key: string): HTMLElement | undefined => path.find((el) => el?.dataset?.[key] !== undefined);
    // A phone's own controls: the Menu button, the drawer, the sheets, the bottom bar's extras.
    if (this.onPhoneClick(has)) {
      return;
    }
    // The bar's icon buttons. Matched along the path, not on the target: the click usually
    // lands on the icon's own SVG.
    if (has("undo")) {
      this.historyStep("undo");
      return;
    }
    if (has("redo")) {
      this.historyStep("redo");
      return;
    }
    const workspaceTab = has("workspaceTab");
    if (workspaceTab) {
      const id = workspaceTab.dataset.workspaceTab;
      if (isWorkspace(id)) {
        this.setWorkspace(id);
      }
      return;
    }
    const source = has("sourceEdit") ?? has("sourceApply") ?? has("sourceCancel") ?? has("sourceClear");
    if (source) {
      this.runSourceAction(source);
      return;
    }
    /*
     * A strip item, not merely something carrying `data-panel`: a host's panel names itself
     * the same way, and without this a click anywhere inside that panel read as a click on
     * the item that opens it — and closed it. The shell's own items sit under `[data-strip]`;
     * a host's are slotted into it, so they answer for their slot instead.
     */
    const strip = path.find(
      (el) =>
        el?.dataset?.panel !== undefined &&
        (el.closest?.("[data-strip]") !== null || el.assignedSlot?.name === "strip")
    );
    if (strip) {
      const panel = strip.dataset.panel;
      if (panel !== undefined && (STRIP_PANEL_IDS.has(panel) || this.hostPanels().some((hosted) => hosted.dataset.panel === panel))) {
        this.switchPanel(this.activePanel === panel ? undefined : panel);
      }
      return;
    }
    if (has("documentMenu")) {
      this.toggleDocumentMenu();
      return;
    }
    const action = has("documentAction");
    if (action) {
      this.runDocumentAction(action);
      return;
    }
    if (has("documentRemoveKeep")) {
      this.closeDocumentMenu();
      this.focusDocumentLabel();
      return;
    }
    if (has("documentRename")) {
      // Typing in the rename box is not a click on the dropdown.
      return;
    }
    if (!has("documentMenuPopover")) {
      this.closeDocumentMenu();
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target?.dataset?.documentRename !== undefined) {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitRename((target as HTMLInputElement).value);
        this.focusDocumentLabel();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.renaming = undefined;
        this.renderDocuments();
        this.focusDocumentLabel();
      }
      return;
    }
    // A phone's sheet or drawer goes on Escape; a surface's own editor answers for itself.
    if (event.key === "Escape" && this.phone && this.sheetKind !== undefined && this.sheetKind !== "surface") {
      event.preventDefault();
      this.closeSheet();
      return;
    }
    if (event.key === "Escape" && !this.documentMenuEl().hidden) {
      event.preventDefault();
      // Focus goes back to the label that opened it.
      this.closeDocumentMenu();
      this.rootNode.querySelector<HTMLElement>("[data-document-menu]")?.focus();
      return;
    }
    // The document's menu: the arrows walk its items,
    // wrapping, and Home and End jump to the ends, as a menu's do.
    if (
      !this.documentMenuEl().hidden &&
      target?.getAttribute?.("role") === "menuitem" &&
      (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")
    ) {
      const items = [...this.documentMenuEl().querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
      const index = items.indexOf(target);
      if (index >= 0) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      }
      return;
    }
    // Arrow keys walk the strip and the tab strip; Enter/Space activate through the button.
    if (target?.dataset?.panel !== undefined && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // A host's items too, slotted after the shell's: the keydown reaches here through their slot.
      const buttons = [
        // Not an item another workspace owns: it is not drawn, so the keys pass it by.
        ...this.rootNode.querySelectorAll<HTMLElement>("[data-strip] [data-panel]:not([hidden]):not([data-out-of-workspace])"),
        ...this.hostStripItems().filter((item) => !item.hasAttribute("hidden") && !item.hasAttribute("data-out-of-workspace") && !item.matches(":disabled"))
      ];
      const index = buttons.indexOf(target);
      if (index >= 0) {
        event.preventDefault();
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
      return;
    }
  }

  private onFocusOut(event: FocusEvent): void {
    const target = event.target as HTMLElement;
    if (target?.dataset?.documentRename !== undefined && this.renaming) {
      // Leaving the box commits what was typed, like a spreadsheet cell.
      this.commitRename((target as HTMLInputElement).value);
    }
  }

  // --- the activity strip -------------------------------------------

  /** Each of SHELL_PANELS with the element it shows. */
  private shellPanelElements(): Array<[ShellPanel["id"], HTMLElement | undefined]> {
    const elements: Record<ShellPanel["id"], HTMLElement | undefined> = {
      form: this.formSettingsEl,
      // The lazy panels' elements in the markup, loaded or not: hiding one is an attribute.
      chrome: this.chromePanelHost,
      components: this.toolbarEl,
      outline: this.outlineEl,
      fields: this.fieldsEl,
      variables: this.variablesPanelHost,
      tests: this.testsPanelHost,
      view: this.viewPanelEl,
      settings: this.settingsPanelEl
    };
    return SHELL_PANELS.map((panel) => [panel.id, elements[panel.id]]);
  }

  /**
   * The author's own move between side panels (a strip item, the rail's All components): a panel
   * that edits the root's draft — Form, Header & footer — asks about its unapplied edits before
   * it goes, as the inspector does when its selection changes.
   */
  private switchPanel(panel: DatumBuilderPanel | undefined): void {
    // The author's own move: the palette's state is theirs from here.
    this.autoPalette = false;
    const holdsRoot = this.activePanel === "form" || this.activePanel === "chrome";
    if (holdsRoot && panel !== this.activePanel) {
      // The Form panel edits the root of the tree on the page (a PDF layout's too); Header & footer the form's.
      const controller = this.activePanel === "chrome" ? this.ctrl : this.activeMode.controller;
      controller.requestPanelLeave(() => this.setPanel(panel));
      return;
    }
    this.setPanel(panel);
  }

  private setPanel(requested: DatumBuilderPanel | undefined): void {
    // A panel the `features` list or `hidden-panels` leaves off is never the open one, nor loaded:
    // the workspace's own opens in its place, a remembered one at connect included.
    const panel = this.usablePanel(requested);
    const leftTests = this.activePanel === "tests" && panel !== "tests";
    this.activePanel = panel;
    // The panel that handed the canvas a scenario step closing ends the showing. Try it taking
    // the side column away to make room for its panel is not the author closing it: the showing is why Try it is on.
    if (leftTests && !this.enteringTry) {
      this.showScenarioOnCanvas(undefined);
    }
    // Another panel open is somebody's choice, not the shell's palette.
    if (panel !== undefined && panel !== "components") {
      this.autoPalette = false;
    }
    if (!this.wrapEl) {
      return;
    }
    this.wrapEl.toggleAttribute("data-side-collapsed", panel === undefined);
    this.wrapEl.toggleAttribute("data-drawer-open", panel !== undefined);
    // The open panel's id, for the drawer widths a panel sets for itself (PANEL_DRAWER_WIDTHS).
    if (panel === undefined) {
      delete this.wrapEl.dataset.openPanel;
    } else {
      this.wrapEl.dataset.openPanel = panel;
    }
    for (const [id, element] of this.shellPanelElements()) {
      if (element) {
        element.hidden = panel !== id;
      }
    }
    let hostFloating = false;
    for (const hosted of this.hostPanels()) {
      hosted.hidden = hosted.dataset.panel !== panel;
      hostFloating ||= !hosted.hidden && hosted.hasAttribute("data-floating");
    }
    // A host's panel that draws its own cards says so (data-floating); slotted, the drawer's :has() cannot see it.
    this.rootNode.querySelector("[data-side]")?.toggleAttribute("data-host-floating", hostFloating);
    // A lazy panel's body is fetched the first time it opens: a remembered one at connect.
    if (isLazyPanel(panel)) {
      void this.ensureLazyPanel(panel);
    }
    // A host's items are marked as the shell's are, so one item shows selected whichever opened it.
    for (const button of [...this.rootNode.querySelectorAll<HTMLElement>("[data-strip] [role=tab]"), ...this.hostStripItems()]) {
      const selected = button.dataset.panel === panel;
      button.setAttribute("aria-selected", String(selected));
    }
    // The rail's All components opens the palette: it shows pressed while the palette is open.
    this.rootNode.querySelector("[data-rail-more]")?.setAttribute("aria-pressed", String(panel === "components"));
    // Narrow: a panel opening as a drawer folds the inspector, so one drawer is up at a time.
    if (this.narrow && panel !== undefined && !this.propertiesEl.collapsed) {
      this.foldInspector(true);
    } else if (this.medium && panel !== undefined && !this.propertiesEl.collapsed && !this.wrapEl.hasAttribute("data-no-selection")) {
      // Medium: one drawer beside the canvas. The palette opening puts the inspector away for the session.
      this.yieldedProps = true;
      this.foldInspector(true);
    } else if (this.medium && panel === undefined && this.yieldedProps) {
      // The drawer that sent the inspector away has gone: the inspector comes back.
      this.yieldedProps = false;
      this.foldInspector(false);
    }
    this.syncPhone();
    this.savePanels();
    this.syncLazyPanelNotes();
    // The shell settling its own palette as it mounts is no move for a host to hear of.
    if (this.quietPanel) {
      return;
    }
    this.dispatchEvent(new CustomEvent<{ panel: DatumBuilderPanel | undefined }>("builder-panel-change", { detail: { panel }, bubbles: true, composed: true }));
  }

  /**
   * Whether the form has nothing to add to yet: no component, or only the Submit
   * button File > New seeds (an untouched one, id and words as seeded). A form with anything
   * else is one the author is working on, and the palette has no business over its canvas.
   */
  private formHasNoComponents(): boolean {
    const components = Object.values(this.ctrl.snapshot().children ?? {}).flatMap((group) => group ?? []);
    if (components.length === 0) {
      return true;
    }
    const [only] = components;
    const configuration = (only?.configuration ?? {}) as { label?: unknown; action?: unknown };
    return components.length === 1 && only?.id === "submit" && only.type === "button" && configuration.label === "Submit" && configuration.action === "submit";
  }

  /**
   * Puts the Components palette as the shell's own rule has it: open for a form with no
   * components, shut for one with some, and never the other way over a choice the author made.
   * Run as the shell comes up and whenever a form is put in place (File > Open and New, a host's
   * definition). A phone or narrow shell keeps its drawers put away. Not written to `persist-panels`.
   */
  private settlePalette(quiet = false): void {
    if (!this.autoPalette || !this.wrapEl || this.workspaceValue !== "form" || this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      return;
    }
    const open = this.activePanel;
    if (open !== undefined && open !== "components") {
      return;
    }
    const wanted = this.formHasNoComponents() ? "components" : undefined;
    if (wanted === open || (wanted !== undefined && (this.narrow || this.phone))) {
      return;
    }
    this.passing = true;
    this.quietPanel = quiet;
    try {
      this.setPanel(wanted);
    } finally {
      this.passing = false;
      this.quietPanel = false;
    }
  }

  /** A click on the canvas puts away a palette the shell opened itself; one the author opened stays. */
  private dismissAutoPalette(): void {
    if (!this.autoPalette || this.activePanel !== "components") {
      return;
    }
    this.passing = true;
    try {
      this.setPanel(undefined);
    } finally {
      this.passing = false;
    }
  }

  // --- the Tests panel -------------------------------------------------------------

  /**
   * Hands a scenario's step to the canvas for Show me, or ends the showing. The canvas method is
   * the canvas role's (`showScenario`); until it exists the call is a no-op, and ending a showing
   * asks nothing of a canvas that never showed one.
   */
  private showScenarioOnCanvas(showing: CanvasScenarioShowing | undefined): void {
    const canvas = this.canvasEl as unknown as { showScenario?(value: CanvasScenarioShowing | undefined): void; scenarioShowing?: CanvasScenarioShowing } | undefined;
    if (showing === undefined) {
      const current = canvas?.scenarioShowing;
      if (current === undefined) {
        return;
      }
      canvas?.showScenario?.(undefined);
      // The shell's own ending (the panel closed, Back to editing) tells the panel, as the canvas's does.
      try {
        current.onStop();
      } catch (error) {
        console.warn("datum-builder: the Tests panel's onStop failed.", error);
      }
      return;
    }
    // Logic, Data and an overview put the canvas away: Show me brings the form's canvas back first, past the
    // unsaved-edits guard, with the Tests panel the one open. A switch the prompt holds back shows nothing.
    if (this.canvasPutAway()) {
      if (!this.availableWorkspaces().includes("form")) {
        showing.onStop();
        return;
      }
      let now = true;
      const ran = this.activeController.requestLeave(() => {
        this.enterWorkspace("form");
        if (now) {
          this.setPanel("tests");
          canvas?.showScenario?.(showing);
        }
      });
      if (!ran) {
        now = false;
        showing.onStop();
      }
      return;
    }
    canvas?.showScenario?.(showing);
  }

  /**
   * What the Tests panel offers that another feature owns: Show me needs Try it's step control
   * (the `try-it` feature), Open rule the Logic workspace. Called when the panel is
   * wired and whenever the features move.
   */
  private syncTestsPanelFeatures(panel: DatumBuilderTestsPanelElement | undefined = this.testsPanelEl): void {
    if (!panel) {
      return;
    }
    const tryIt = featureOn(this.featuresValue, "try-it");
    panel.showOnCanvas = tryIt ? (showing) => this.showScenarioOnCanvas(showing) : undefined;
    panel.openRuleAvailable = this.availableWorkspaces().includes("logic");
    // Record and Assert this ride on Try it's runtime: offered while the feature is on, else the
    // panel draws neither. The callbacks reach the canvas when called, so a canvas rebuilt since is the one asked.
    const recording = panel as unknown as {
      recordOnCanvas?: ((listener: TestsRecordListener) => () => void) | undefined;
      assertSnapshot?: (() => TestsAssertSnapshot | undefined) | undefined;
      assertReady?: (() => boolean) | undefined;
    };
    // Stable functions, set only when the answer changes: the panel ends a recording when it loses the callback.
    const record = tryIt ? this.recordOnCanvasForTests : undefined;
    if (recording.recordOnCanvas !== record) {
      recording.recordOnCanvas = record;
    }
    const assert = tryIt ? this.assertSnapshotForTests : undefined;
    if (recording.assertSnapshot !== assert) {
      recording.assertSnapshot = assert;
    }
    // Whether Assert this has a form to read, without building the snapshot to find out: set before a paint asks.
    const ready = tryIt ? this.assertReadyForTests : undefined;
    if (recording.assertReady !== ready) {
      recording.assertReady = ready;
    }
  }

  /**
   * Record from the Tests drawer in Logic, Data or an overview brings the form's canvas back
   * first, past the unsaved-edits guard, as Show me does: Try it on a canvas that is put
   * away would record over a form nobody can see. A switch the prompt holds back starts nothing
   * (the throw is the panel's "could not start").
   */
  private readonly recordOnCanvasForTests = (listener: TestsRecordListener): (() => void) => {
    if (this.canvasPutAway()) {
      if (!this.availableWorkspaces().includes("form")) {
        throw new Error("datum-builder: Record needs the Form workspace.");
      }
      let now = true;
      const ran = this.activeController.requestLeave(() => {
        this.enterWorkspace("form");
        if (now) {
          this.setPanel("tests");
        }
      });
      if (!ran) {
        now = false;
        throw new Error("datum-builder: Record waits for the unsaved edits.");
      }
    }
    return this.recordingCanvas()?.recordTry(listener) ?? (() => undefined);
  };

  /** Whether the Tests panel is recording (its `recording` getter); false before its chunk is wired. */
  private testsPanelRecording(): boolean {
    return (this.testsPanelEl as unknown as { recording?: unknown } | undefined)?.recording === true;
  }
  private readonly assertSnapshotForTests = (): TestsAssertSnapshot | undefined => this.recordingCanvas()?.assertSnapshot();
  /** The canvas's own cheap answer to "would `assertSnapshot` give a form now" (its `assertReady`), read through a cast. */
  private readonly assertReadyForTests = (): boolean => (this.recordingCanvas() as { assertReady?: unknown } | undefined)?.assertReady === true;

  /** The canvas as the Tests panel's Record and Assert this see it; absent until the canvas role's methods land. */
  private recordingCanvas(): TestsCanvasRecording | undefined {
    const canvas = this.canvasEl as unknown as Partial<TestsCanvasRecording> | undefined;
    return typeof canvas?.recordTry === "function" && typeof canvas.assertSnapshot === "function" ? (canvas as TestsCanvasRecording) : undefined;
  }

  /** Whether the workspace on the page puts the canvas away (the styles' `display: none` for these). */
  private canvasPutAway(): boolean {
    const workspace = this.workspaceValue;
    return workspace === "logic" || workspace === "data" || workspace === "languages" || workspace === "print" || this.overviewShown;
  }

  /** Listens to the panel's events on its host, which outlives the upgrade; the markup redraw makes a new host and listens again. */
  private wireTestsPanelHost(): void {
    const host = this.testsPanelHost;
    if (!host) {
      return;
    }
    host.addEventListener("builder-tests-status", (event) => {
      const failed = (event as CustomEvent<BuilderTestsStatusDetail>).detail?.failed;
      this.testsFailing = typeof failed === "number" && failed > 0 ? Math.floor(failed) : 0;
      this.applyTestsCount();
    });
    host.addEventListener("builder-tests-open-rule", (event) => {
      const detail = (event as CustomEvent<BuilderTestsOpenRuleDetail>).detail;
      if (detail && typeof detail.componentId === "string") {
        this.openRuleInLogic(detail.componentId, typeof detail.kind === "string" ? detail.kind : undefined);
      }
    });
    // A leave held for the panel's unapplied edit is asked in the panel: a closed panel is opened to ask it.
    host.addEventListener("builder-tests-reveal", () => {
      if (this.activePanel !== "tests" && !this.panelOff("tests")) {
        this.setPanel("tests");
      }
    });
    this.applyTestsCount();
  }

  /**
   * The count on the Tests strip item: tests failing, erroring or not parsing, as the panel last
   * said. Drawn as the workspace tabs draw theirs (a danger chip, hidden from a screen reader and
   * put into the item's name in words) and gone at zero.
   */
  private applyTestsCount(): void {
    const item = this.rootNode?.querySelector<HTMLElement>("[data-tests-panel-item]");
    if (!item) {
      return;
    }
    const label = this.words.text("shell.panel.tests.label");
    let badge = item.querySelector<HTMLElement>(".strip-count");
    if (this.testsFailing > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "strip-count";
        badge.setAttribute("aria-hidden", "true");
        item.append(badge);
      }
      badge.textContent = String(this.testsFailing);
      item.setAttribute("aria-label", this.words.text("phoneMenu.row", { label, problems: this.words.plural("problems.count", this.testsFailing) }));
    } else {
      badge?.remove();
      item.setAttribute("aria-label", label);
    }
  }

  /**
   * Open rule: Logic comes up on the component's rule. Logic is a lazy
   * surface, so the request waits in {@link pendingRuleOpen} until the surface is there. A switch
   * the unsaved-edits prompt holds back drops the request: it should not fire later, when the
   * author opens Logic for another reason.
   */
  private openRuleInLogic(componentId: string, kind?: string): void {
    if (!this.availableWorkspaces().includes("logic")) {
      return;
    }
    this.pendingRuleOpen = componentId;
    this.pendingRuleKind = kind;
    if (!this.setWorkspace("logic")) {
      this.pendingRuleOpen = undefined;
      this.pendingRuleKind = undefined;
      return;
    }
    this.flushPendingRuleOpen();
  }

  private flushPendingRuleOpen(): void {
    if (this.pendingRuleOpen === undefined || !this.logicEl) {
      return;
    }
    const componentId = this.pendingRuleOpen;
    const kind = this.pendingRuleKind;
    this.pendingRuleOpen = undefined;
    this.pendingRuleKind = undefined;
    // A field with several rules opens the one the test reads; no kind: its first.
    if (kind === undefined) {
      this.logicEl.openRuleFor(componentId);
    } else {
      this.logicEl.openRuleFor(componentId, kind);
    }
  }

  /**
   * Opens the Tests panel (the drawer of the workspace the author is in) and, once its chunk is
   * wired, calls `call` on it: the Logic editor's Pinned-by buttons land here.
   * Nothing happens where the Tests panel is off; a drawer switch the unsaved-edits prompt holds
   * back drops the call, which should not fire later when the panel opens for another reason.
   */
  private async withTestsPanel(call: (panel: { openEntry?(id: string): void; writeTestFor?(ruleId: string): void }) => void): Promise<void> {
    if (this.panelOff("tests")) {
      return;
    }
    this.switchPanel("tests");
    await this.ensureLazyPanel("tests");
    const panel = this.testsPanelEl as unknown as { openEntry?(id: string): void; writeTestFor?(ruleId: string): void } | undefined;
    if (panel && this.activePanel === "tests") {
      call(panel);
    }
  }

  /**
   * Feeds the Logic surface's "Pinned by" line. With no scenarios there is
   * nothing to read, so the surface gets an answer of "none" without the Tests chunk being
   * fetched (its Write a test is then the way in); with scenarios the chunk is loaded and
   * the pins are the coverage of the committed tree by the parsed entries, memoised by the
   * controller change and the tests block. Until the chunk answers the surface draws no line.
   * Recomputed only while Logic is the workspace, since nothing else shows the line.
   */
  private feedTestsPins(): void {
    const logic = this.logicEl;
    if (!logic) {
      return;
    }
    if (this.panelOff("tests")) {
      this.testsPinsMemo = undefined;
      logic.testsPins = undefined;
      return;
    }
    if (this.workspaceValue !== "logic") {
      return;
    }
    const tests = this.ctrl.tests();
    // The controller hands out a copy of the block each time, so the memo compares what it holds.
    const key = tests ? JSON.stringify(tests) : "";
    const memo = this.testsPinsMemo;
    if (memo && memo.stamp === this.testsPinsStamp && memo.key === key) {
      logic.testsPins = memo.source;
      return;
    }
    const request = ++this.testsPinsRequest;
    const stamp = this.testsPinsStamp;
    const settle = (source: TestsPinsOf | undefined): void => {
      if (request !== this.testsPinsRequest) {
        return;
      }
      this.testsPinsMemo = source ? { stamp, key, source } : undefined;
      if (this.logicEl === logic) {
        logic.testsPins = source;
      }
    };
    if (!tests?.scenarios.length) {
      settle(() => []);
      return;
    }
    const loaded = testsPanelLoaded();
    if (loaded) {
      settle(this.testsPinsFrom(loaded, tests));
      return;
    }
    // Pins from before this change could name tests that are gone: draw nothing until the chunk answers.
    logic.testsPins = undefined;
    loadTestsPanel().then(
      (module) => settle(this.testsPinsFrom(module, tests)),
      (cause: unknown) => this.reportFailure(`${this.words.text("shell.load.failed.tests")} ${this.words.text("shell.load.check")}`, cause)
    );
  }

  /** The pins of a tests block over the committed tree, through the chunk's coverage; `undefined` when the chunk cannot answer. */
  private testsPinsFrom(module: unknown, tests: FormTestConfiguration): TestsPinsOf | undefined {
    // The entries come from the chunk's parser: its own `parseTestsEntries`, else the runner it builds (`parse` is pure).
    const chunk = module as {
      parseTestsEntries?(tests: FormTestConfiguration, signatures: readonly FormulaFunctionSignature[]): TestsEntryModel[];
      createTestsRunner?(options: { definition(): FormDefinition | undefined; root(): ComponentNode; signatures(): readonly FormulaFunctionSignature[] }): { parse(tests: FormTestConfiguration | undefined): TestsEntryModel[] };
      testsPinsOf?(root: ComponentNode, definition: FormDefinition, entries: readonly TestsEntryModel[], signatures: readonly FormulaFunctionSignature[]): ReadonlyMap<string, readonly TestsPin[]>;
    };
    if (!chunk.testsPinsOf || (!chunk.parseTestsEntries && !chunk.createTestsRunner)) {
      return undefined;
    }
    try {
      const signatures: readonly FormulaFunctionSignature[] = this.formulaFunctionsValue?.signatures() ?? [];
      const root = this.ctrl.snapshot();
      const whole = this.logicDefinitionSource?.();
      const definition: FormDefinition = whole ? { ...whole, root } : { id: "builder-tests", version: "0.0.0", schemaVersion: "1", root };
      const entries = chunk.parseTestsEntries
        ? chunk.parseTestsEntries(tests, signatures)
        : chunk.createTestsRunner!({ definition: () => undefined, root: () => root, signatures: () => signatures }).parse(tests);
      const pins = chunk.testsPinsOf(root, definition, entries, signatures);
      return (ruleId) => pins.get(ruleId) ?? [];
    } catch (cause) {
      console.warn("datum-builder: the Pinned-by line could not be read from the tests.", cause);
      return undefined;
    }
  }

  /**
   * A rename in the form is followed in the scenarios that name the field:
   * the tests panel's chunk rewrites the sources, in the rename's own step of the history. The
   * chunk loads here when it has not (a form with scenarios renames before the panel was ever
   * opened); a failed load is the host's datum-error and the scenarios stay as they were. Each
   * rename waits for the one before it, so two quick renames both land.
   */
  private followRenameInTests(renamed: { from: string; to: string }, root: ComponentNode): void {
    // No Tests panel on this page, no chunk to fetch: an absent-code host would answer each rename with a datum-error.
    if (this.panelOff("tests") || !this.ctrl.tests()?.scenarios.length) {
      return;
    }
    // A component with a data key keeps its value path under a new id: the scenarios name that path, not the id.
    const node = findNodeById(root, renamed.to);
    const dataKey = (node?.configuration as { dataKey?: unknown } | undefined)?.dataKey;
    if (typeof dataKey === "string" && dataKey !== "") {
      return;
    }
    this.queueTestsRename(renamed, undefined);
  }

  /**
   * The scenarios' value paths follow a move of the data as a rename's ids do: queued
   * behind any rename before it, every move of the edit applied as one map, and the rewrite joined
   * to the edit's step of the history while nothing else was done since, or held for its Redo
   * while the edit is undone. A step that also renamed the component is the rename's, so its ids
   * are the step's key.
   */
  private followDataMovedInTests(moves: readonly ValuePathMove[], renamed: { from: string; to: string } | undefined): void {
    if (this.panelOff("tests") || !this.ctrl.tests()?.scenarios.length) {
      return;
    }
    const [first] = moves;
    const key = renamed ? { from: renamed.from, to: renamed.to } : first ? { from: first.from, to: first.to } : undefined;
    if (!key) {
      return;
    }
    const generation = this.testsGeneration;
    this.testsRenameChain = this.testsRenameChain.then(async () => {
      try {
        const module = await loadTestsPanel();
        if (generation !== this.testsGeneration) {
          return;
        }
        const signatures: readonly FormulaFunctionSignature[] = this.formulaFunctionsValue?.signatures() ?? [];
        const next = module.moveValuePathsInTests(this.ctrl.tests(), moves, signatures);
        if (next !== undefined) {
          this.followInStep(key, () => this.ctrl.setTests(next), () => this.followDataMovedInTests(moves, renamed));
        }
      } catch (cause) {
        this.reportFailure(`${this.words.text("shell.load.failed.tests")} ${this.words.text("shell.load.check")}`, cause);
      }
    });
  }

  /**
   * Where each language the form was loaded (or last saved) with stands now: its code then, to
   * its code now. A change to a language's code is the difference between this and the
   * controller's lineage, so a rename and the undo of one are both seen, and a save, which makes
   * the codes as they stand the baseline, starts the map over.
   */
  private localeTargets = new Map<string, string>();

  /** The scenarios follow every language whose code changed since the last change, in `given locale`. */
  private followLocaleRenames(): void {
    const now = new Map(this.ctrl.localeChangesSinceSave().renamed.map((entry) => [entry.from, entry.to]));
    // The controller also starts its lineage over without a rename or an undo (the languages set
    // again as they stand), which leaves a rename it had seen looking undone. A move counts only
    // when it ends in a code the form declares and starts from one it no longer does.
    const declared = new Set(supportedLocaleCodes(this.ctrl.localization()));
    const moves: Array<{ from: string; to: string }> = [];
    for (const [origin, code] of now) {
      const before = this.localeTargets.get(origin) ?? origin;
      if (before !== code && declared.has(code) && !declared.has(before)) {
        moves.push({ from: before, to: code });
      }
    }
    for (const [origin, before] of this.localeTargets) {
      if (!now.has(origin) && before !== origin && declared.has(origin) && !declared.has(before)) {
        moves.push({ from: before, to: origin });
      }
    }
    this.localeTargets = now;
    if (moves.length > 0 && !this.panelOff("tests") && this.ctrl.tests()?.scenarios.length) {
      this.queueLocaleRename(moves);
    }
  }

  /** The same queue the component renames wait in, so a language rename and a component rename land in order. */
  private queueLocaleRename(moves: ReadonlyArray<{ from: string; to: string }>): void {
    const generation = this.testsGeneration;
    this.testsRenameChain = this.testsRenameChain.then(async () => {
      try {
        const module = await loadTestsPanel();
        if (generation !== this.testsGeneration) {
          return;
        }
        const signatures: readonly FormulaFunctionSignature[] = this.formulaFunctionsValue?.signatures() ?? [];
        for (const move of moves) {
          const current = this.ctrl.tests();
          const next = current ? module.renameLocaleInTests(current, move.from, move.to, signatures) : undefined;
          if (next !== undefined) {
            this.ctrl.setTests(next);
          }
        }
      } catch (cause) {
        this.reportFailure(`${this.words.text("shell.load.failed.tests")} ${this.words.text("shell.load.check")}`, cause);
      }
    });
  }

  /**
   * A page or journey id the Journeys mode renamed is followed in the scenarios the same way a
   * component's is: `page` refs for a page, `journey` refs for a journey.
   * The mode tells the shell itself with a bubbling `builder-journey-rename` event, and the shell's
   * listener comes here, so no host forwards anything. The method stays public for a mode mounted
   * outside the builder's tree (its event never reaches the shell): that host forwards the mode's
   * `onChange` detail (`reason` `"page-rename"` or `"journey-rename"`, `renamed` the ids). A host that
   * forwards while the mode is in the tree renames twice, and the second finds nothing to rewrite.
   * Any other detail is ignored, so a host may forward every change. A detail whose rename the mode
   * did not make in this form is the host's to filter.
   */
  public followJourneyChange(detail: { reason?: string; renamed?: { journeyId?: unknown; from?: unknown; to?: unknown } | undefined } | undefined): void {
    const kind = detail?.reason === "page-rename" ? "page" : detail?.reason === "journey-rename" ? "journey" : undefined;
    const from = detail?.renamed?.from;
    const to = detail?.renamed?.to;
    if (kind === undefined || typeof from !== "string" || typeof to !== "string" || from === to) {
      return;
    }
    if (this.panelOff("tests") || !this.ctrl.tests()?.scenarios.length) {
      return;
    }
    // A page id is the journey's own: another journey's page of the same id stays.
    const journeyId = kind === "page" && typeof detail?.renamed?.journeyId === "string" ? detail.renamed.journeyId : undefined;
    this.queueTestsRename({ from, to }, kind, journeyId);
  }

  /**
   * One rename's rewrite of the scenarios, queued behind the one before it: the chunk loads if it
   * has not, and a form opened meanwhile drops the follow. A component's rename takes the rewrite
   * into its own step of the history while nothing else was done since (one Undo puts the id and
   * the scenarios back together), writes nothing while the rename is undone (its Redo brings the
   * rewrite back, {@link followInStep}), and is a step of its own after other edits; a page's or
   * a journey's is always a step of its own.
   */
  private queueTestsRename(renamed: { from: string; to: string }, kind: "page" | "journey" | undefined, journeyId?: string): void {
    const generation = this.testsGeneration;
    this.testsRenameChain = this.testsRenameChain.then(async () => {
      try {
        const module = await loadTestsPanel();
        // Another form opened while the chunk came: the rename was the last form's.
        if (generation !== this.testsGeneration) {
          return;
        }
        const current = this.ctrl.tests();
        if (!current?.scenarios.length) {
          return;
        }
        const signatures: readonly FormulaFunctionSignature[] = this.formulaFunctionsValue?.signatures() ?? [];
        // The journey a scenario with no `given journey` runs, as coverage and the kernel pick it.
        const whole = journeyId !== undefined ? this.logicDefinitionSource?.() : undefined;
        const defaultJourneyId = whole !== undefined ? (findJourney(whole) ?? readJourneys(whole)[0])?.id : undefined;
        const next =
          kind === undefined
            ? module.renameInTests(current, renamed.from, renamed.to, signatures)
            : module.renameInTests(current, renamed.from, renamed.to, signatures, {
                kind,
                ...(journeyId !== undefined ? { journeyId } : {}),
                ...(defaultJourneyId !== undefined ? { defaultJourneyId } : {})
              });
        if (next === undefined) {
          return;
        }
        if (kind === undefined) {
          // A component's rename: the scenarios join its entry of the history while it is still the last thing done.
          this.followInStep(renamed, () => this.ctrl.setTests(next), () => this.queueTestsRename(renamed, undefined));
        } else {
          this.ctrl.setTests(next);
        }
      } catch (cause) {
        this.reportFailure(`${this.words.text("shell.load.failed.tests")} ${this.words.text("shell.load.check")}`, cause);
      }
    });
  }

  /**
   * Writes a follow-up that landed a moment after its step (`write`: the scenarios rewritten once
   * their chunk is in) into that step of the history, named by `key` (the rename's ids, or the
   * first value path the edit moved). The controller drops a follow-up whose step was undone
   * meanwhile, so the scenarios never name an id or a path the form no longer has and the Redo
   * stays; the follow is kept to run again (`again`, against the scenarios as they are then) when
   * that step is redone.
   */
  private followInStep(key: { from: string; to: string }, write: () => void, again: () => void): void {
    let wrote = false;
    const joined = this.ctrl.followRename(key, () => {
      wrote = true;
      write();
    });
    if (!joined && !wrote) {
      this.droppedFollows.push({ key: { from: key.from, to: key.to }, again });
    }
  }

  /** A Redo put a step back: the follow-ups dropped while it was undone run now, named by the ids or the first path it moves. */
  private followRedone(event: { renameStepped?: { from: string; to: string } | undefined; dataMoved?: readonly ValuePathMove[] | undefined }): void {
    const keys = [event.renameStepped, event.dataMoved?.[0]].filter((key): key is { from: string; to: string } => key !== undefined);
    if (keys.length === 0 || this.droppedFollows.length === 0) {
      return;
    }
    const redone = this.droppedFollows.filter((follow) => keys.some((key) => key.from === follow.key.from && key.to === follow.key.to));
    this.droppedFollows = this.droppedFollows.filter((follow) => !redone.includes(follow));
    for (const follow of redone) {
      follow.again();
    }
  }

  private lazyPanelHost(id: LazyPanelId): HTMLElement | undefined {
    return id === "chrome" ? this.chromePanelHost : id === "variables" ? this.variablesPanelHost : this.testsPanelHost;
  }

  /** The upgraded element of a lazy panel, once its chunk is wired. */
  private lazyPanelElement(id: LazyPanelId): HTMLElement | undefined {
    return id === "chrome" ? this.chromePanelEl : id === "variables" ? this.variablesPanelEl : this.testsPanelEl;
  }

  /**
   * Makes a lazy strip panel's body ready: at once when its chunk is already on the
   * page, else fetched, its element showing the loading card meanwhile and the failure card
   * with Retry when the fetch fails. Resolves once the panel is wired (or the load failed, or
   * the markup was redrawn while it was in flight: the new markup asks for itself). One load
   * per panel at a time; the loaders fetch each chunk once per page.
   */
  private ensureLazyPanel(id: LazyPanelId): Promise<void> {
    const host = this.lazyPanelHost(id);
    const loader = panelLoader(id);
    if (!host || !loader || this.lazyPanelElement(id)) {
      return Promise.resolve();
    }
    // Focus on the failure card's Retry (or the loading card) is destroyed when the card is replaced: remember it, and put it back.
    const hadFocus = this.focusIsIn(host);
    if (loader.loaded()) {
      this.adoptLazyPanelSafely(id, host, hadFocus);
      return Promise.resolve();
    }
    const inFlight = this.lazyPanelLoads.get(id);
    if (inFlight && inFlight.host === host) {
      return inFlight.promise;
    }
    // No aria-busy: a busy live region is not announced, and nothing would clear it (the card is replaced).
    host.innerHTML = `<div class="logic-state" role="status" tabindex="-1"><p>${escapeHtml(this.words.text(`shell.load.${id}`))}</p></div>`;
    if (hadFocus) {
      host.querySelector<HTMLElement>("[role=status]")?.focus();
    }
    const promise = loader.load().then(
      () => {
        if (this.lazyPanelLoads.get(id)?.promise === promise) {
          this.lazyPanelLoads.delete(id);
        }
        if (this.lazyPanelHost(id) === host) {
          this.adoptLazyPanelSafely(id, host, hadFocus || this.focusIsIn(host));
        }
      },
      (cause: unknown) => {
        if (this.lazyPanelLoads.get(id)?.promise === promise) {
          this.lazyPanelLoads.delete(id);
        }
        this.lazyPanelFailed(id, host, cause, hadFocus || this.focusIsIn(host));
      }
    );
    this.lazyPanelLoads.set(id, { host, promise });
    return promise;
  }

  private focusIsIn(host: HTMLElement): boolean {
    const active = this.rootNode.activeElement;
    return active !== null && host.contains(active);
  }

  /**
   * Adopts a loaded panel; a throw (a panel setter, its resume paint) is the failure card and a
   * datum-error, never an unhandled rejection. The focus the card held moves into the panel.
   */
  private adoptLazyPanelSafely(id: LazyPanelId, host: HTMLElement, hadFocus: boolean): void {
    try {
      this.adoptLazyPanel(id);
    } catch (cause) {
      this.lazyPanelFailed(id, host, cause, hadFocus);
      return;
    }
    // The card that held focus is gone: focus the panel's heading, so the keyboard stays in the drawer (Escape still reaches the shell).
    if (hadFocus && this.lazyPanelHost(id) === host && this.rootNode.activeElement === null) {
      const heading = host.shadowRoot?.querySelector<HTMLElement>(".chrome-head, .variables-head, .tests-head");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  }

  private lazyPanelFailed(id: LazyPanelId, host: HTMLElement, cause: unknown, hadFocus: boolean): void {
    const adopted = this.lazyPanelElement(id);
    if (this.lazyPanelHost(id) === host && !adopted) {
      // Adopting hides the host while it upgrades: put its visibility back for the card.
      host.hidden = this.activePanel !== id;
      host.innerHTML = this.failedCard(`shell.load.failed.${id}`, `data-panel-retry="${id}"`);
      if (hadFocus) {
        host.querySelector<HTMLElement>("[data-panel-retry]")?.focus();
      }
    } else if (this.lazyPanelHost(id) === host && adopted) {
      // The panel was upgraded and wired before a setter threw: it keeps what it drew, and its
      // shadow root cannot take a light-DOM card, so the failure sits beside it.
      this.showWiredPanelFailure(id, host, cause);
    }
    // The host hears it too (absent-code resilience); Retry, or opening the panel again, fetches anew.
    this.reportFailure(`${this.words.text(`shell.load.failed.${id}`)} ${this.words.text("shell.load.check")}`, cause);
  }

  /** The alert beside a panel that wired but threw: shown while that panel is the open one, gone with the markup. */
  private showWiredPanelFailure(id: LazyPanelId, host: HTMLElement, cause: unknown): void {
    this.lazyPanelNotes.get(id)?.remove();
    const reason = cause instanceof Error ? cause.message : String(cause);
    host.insertAdjacentHTML(
      "beforebegin",
      `<div class="logic-state" role="alert" data-panel-failed="${id}"${this.activePanel === id ? "" : " hidden"}><p><strong>${escapeHtml(this.words.text(`shell.load.failed.${id}`))}</strong></p><p>${escapeHtml(reason)}</p></div>`
    );
    this.lazyPanelNotes.set(id, host.previousElementSibling as HTMLElement);
  }

  private readonly lazyPanelNotes = new Map<LazyPanelId, HTMLElement>();

  /** Keeps a wired panel's failure note in step with which panel is open. */
  private syncLazyPanelNotes(): void {
    for (const [id, note] of this.lazyPanelNotes) {
      note.hidden = this.activePanel !== id;
    }
  }

  /**
   * Upgrades a lazy panel's element in the side column and feeds it everything the shell would
   * have set on it, in one paint: hidden while it upgrades, so its connect paints
   * nothing, then the properties under suspendPaints, its own hidden state put back last.
   */
  private adoptLazyPanel(id: LazyPanelId): void {
    const host = this.lazyPanelHost(id);
    const module = panelLoader(id)?.loaded();
    if (!host || !module || this.lazyPanelElement(id)) {
      return;
    }
    const shown = !host.hidden;
    host.hidden = true;
    // The loading or failure card was light DOM; the panel draws in its own shadow root.
    host.replaceChildren();
    module.define();
    if (typeof customElements !== "undefined") {
      customElements.upgrade(host);
    }
    if (typeof (host as Partial<DatumBuilderChromePanelElement>).suspendPaints !== "function") {
      // No custom elements here (a server render): the element stays bare.
      host.hidden = !shown;
      return;
    }
    const primary = this.activeMode.id === PRIMARY_BUILDER_MODE;
    if (id === "chrome") {
      const panel = host as DatumBuilderChromePanelElement;
      panel.suspendPaints();
      try {
        panel.textLocale = this.textLocaleValue;
        panel.textCatalog = this.textCatalogValue;
        panel.icons = this.optionsState.icons;
        panel.primary = primary;
        panel.jsonEnabled = featureOn(this.featuresValue, "json");
        panel.translationsEnabled = featureOn(this.featuresValue, "translations");
        panel.languagesWorkspace = this.availableWorkspaces().includes("languages");
        panel.controller = this.activeMode.controller;
      } finally {
        // Its own hidden state goes back even when a setter threw, so the resume paint can draw.
        host.hidden = !shown;
        this.chromePanelEl = panel;
        panel.resumePaints();
      }
    } else if (id === "variables") {
      const panel = host as DatumBuilderVariablesPanelElement;
      panel.suspendPaints();
      try {
        panel.workspace = this.workspaceValue;
        panel.syntax = this.workspaceValue === "print" ? "placeholders" : undefined;
        // The references are the form's fields on every tab, so the panel reads the form's controller throughout.
        panel.controller = this.ctrl;
        this.feedVariablesFunctions(panel);
        panel.icons = this.optionsState.icons;
        panel.primary = primary;
        panel.modeSyntax = this.activeMode.variables;
        panel.journeyController = this.activeMode.id === DESIGNER_WORKSPACES.journeys ? this.activeMode.controller : undefined;
      } finally {
        host.hidden = !shown;
        this.variablesPanelEl = panel;
        panel.resumePaints();
      }
    } else {
      const panel = host as DatumBuilderTestsPanelElement;
      panel.suspendPaints();
      try {
        panel.textLocale = this.textLocaleValue;
        panel.textCatalog = this.textCatalogValue;
        panel.icons = this.optionsState.icons;
        panel.primary = primary;
        // Tests are the form's on every tab: the panel reads the form's controller throughout, as Variables does.
        panel.controller = this.ctrl;
        // The whole definition (journeys, layouts, localization) for the runtime a scenario runs on; the panel swaps in the committed tree.
        panel.definition = () => this.logicDefinitionSource?.();
        panel.formulaFunctions = this.formulaFunctionsValue;
        panel.dataSources = () => this.ctrl.dataSources();
        // Put back open by persist-panels: its first opening does not run the suite (set before it is shown).
        (panel as unknown as { restored?: boolean }).restored = this.testsRestored;
        this.testsRestored = false;
        this.syncTestsPanelFeatures(panel);
      } finally {
        host.hidden = !shown;
        this.testsPanelEl = panel;
        panel.resumePaints();
      }
    }
  }

  /**
   * The inspector column follows the selection: it is there when a component is
   * selected and gone — no stub, no grip, the canvas taking the width — when none is. Its own
   * `collapsed` state is left alone, so an author who folded it gets it back folded.
   *
   * The root is not an inspector subject. Selecting it (the outline's first row, the canvas's
   * root) opens the Form panel instead, so form-level settings are edited in one place.
   */
  private syncInspector(): void {
    if (!this.wrapEl) {
      return;
    }
    const controller = this.activeMode.controller;
    const selected = controller.selectedComponentId();
    const isRoot = selected !== undefined && selected === controller.rootId();
    this.wrapEl.toggleAttribute("data-no-selection", selected === undefined || isRoot);
    // In Logic the inspector opens on the selection's rules.
    if (this.workspaceValue === "logic" && selected !== undefined && !isRoot) {
      this.propertiesEl.inspectorTab = "rules";
    }
    // A phone: picking a component in the Components or Outline sheet puts the sheet away.
    if (this.phone && selected !== this.selectionSeen && (this.activePanel === "components" || this.activePanel === "outline")) {
      this.setPanel(undefined);
    }
    // Medium: a selection that brings the inspector up sends the palette drawer away, for the session only.
    if (
      this.medium && selected !== undefined && !isRoot && selected !== this.selectionSeen && this.activePanel !== undefined &&
      !this.propertiesEl.collapsed && !["logic", "data", "languages", "print"].includes(this.workspaceValue)
    ) {
      this.passing = true;
      try {
        this.setPanel(undefined);
      } finally {
        this.passing = false;
      }
    }
    this.selectionSeen = selected;
    if (isRoot && this.activePanel !== "form" && !this.panelOff("form")) {
      this.setPanel("form");
    }
    this.syncPhone();
  }

  /** Opens the inspector; Narrow shows one drawer at a time, so the side drawer goes. */
  private openInspector(): void {
    this.yieldedProps = false;
    this.foldInspector(false);
    if ((this.narrow || this.medium) && this.activePanel !== undefined) {
      this.setPanel(undefined);
    }
  }

  /** Folds or opens the inspector from the shell's side (its stub's button goes through panel-toggle). */
  private foldInspector(collapsed: boolean): void {
    if (this.propertiesEl.collapsed !== collapsed) {
      this.propertiesEl.collapsed = collapsed;
    }
    this.wrapEl.toggleAttribute("data-props-collapsed", collapsed);
    this.syncPhone();
  }

  // --- the phone tier ---------------------------------------

  /** Whether the shell is a phone: under 768px of its own box, one top row, a bottom bar and sheets. */
  public get phoneLayout(): boolean {
    return this.phone;
  }

  /**
   * Whether the host's definition is saved, for the menu drawer's state line on a phone.
   * `<datum-form-builder>` forwards its own `dirty`; unset, the line says nothing.
   */
  public set saveState(value: "saved" | "unsaved" | undefined) {
    this.saveStateValue = value;
    this.syncSaveCue();
    if (this.menuOpen) {
      this.renderMenu();
    }
  }

  public get saveState(): "saved" | "unsaved" | undefined {
    return this.saveStateValue;
  }

  /**
   * The bar's cue that the form is unsaved: a dot and its words, in view (the tooltip
   * repeats them), drawn here from `saveState` rather than slotted in by the host element, so
   * the host's `history` slot stays the page's own (a phone's drawer lists that slot's items under
   * "From the page"). Shown only while the state is `"unsaved"`.
   */
  private syncSaveCue(): void {
    const cue = this.rootNode?.querySelector<HTMLElement>("[data-save-cue]");
    if (!cue) {
      return;
    }
    // The words are read each time (not left to the markup): a language change reaches them here.
    const words = this.words.text("shell.menu.unsaved");
    cue.title = words;
    const text = cue.querySelector<HTMLElement>("[data-save-cue-text]");
    if (text && text.textContent !== words) {
      text.textContent = words;
    }
    cue.hidden = this.saveStateValue !== "unsaved";
  }

  /** Turns the phone tier on or off: the parts are told, the host's bar slots move, the sheets put away. */
  private setPhone(on: boolean): void {
    if (on === this.phone || !this.wrapEl) {
      return;
    }
    this.phone = on;
    this.phoneTouched = true;
    this.wrapEl.toggleAttribute("data-phone", on);
    if (on) {
      // A phone opens on a clear canvas: no sheet until the author asks for one.
      if (this.activePanel !== undefined) {
        this.setPanel(undefined);
      }
      this.foldInspector(true);
    } else {
      this.menuOpen = false;
      this.moreOpen = false;
      this.resultsOpen = false;
      this.canvasEl?.removeAttribute("data-results-open");
      this.rootNode.querySelector<HTMLElement>("[data-menu-drawer]")?.toggleAttribute("hidden", true);
      this.rootNode.querySelector<HTMLElement>("[data-more-sheet]")?.toggleAttribute("hidden", true);
    }
    this.applyPhoneToParts();
    this.placeModeActions();
    this.moveHostSlots(on);
    this.syncPhone();
    if (on && this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      this.fitDesignerSoon();
    }
  }

  /** Every part with a look of its own reads the tier from its own attribute (its shadow root cannot see the shell's). */
  private applyPhoneToParts(): void {
    const on = this.phone;
    for (const part of [
      this.canvasEl,
      this.propertiesEl,
      this.toolbarEl,
      this.outlineEl,
      this.fieldsEl,
      this.formSettingsEl,
      this.chromePanelHost,
      this.variablesPanelHost,
      this.testsPanelHost,
      this.logicEl,
      this.dataEl,
      this.languagesEl,
      this.printEl,
      this.overviewEl,
      this.paletteEl
    ]) {
      part?.toggleAttribute("data-phone", on);
    }
    // On a phone the inspector and the Form panels sit in a sheet with a frame of their own, not as floating cards.
    for (const part of [this.propertiesEl, this.formSettingsEl, this.chromePanelHost]) {
      part?.toggleAttribute("data-floating", !on);
    }
  }

  /**
   * The host's bar controls (the slots) and a mode's own actions move into the menu
   * drawer on a phone, a marker left where each stood, and back again when the shell widens.
   * The slots move, not what is slotted: the host's elements stay where the host put them.
   */
  private moveHostSlots(on: boolean): void {
    const host = this.rootNode.querySelector<HTMLElement>("[data-menu-host]");
    if (!host) {
      return;
    }
    if (on && this.hostSlotHomes.length === 0) {
      const parts: HTMLElement[] = [
        ...PHONE_HOST_SLOTS.map((name) => this.rootNode.querySelector<HTMLElement>(`.bar-end slot[name="${name}"]`)).filter((slot): slot is HTMLElement => slot !== null),
        ...(this.modeActionsEl ? [this.modeActionsEl] : [])
      ];
      for (const part of parts) {
        const marker = document.createComment("phone");
        part.before(marker);
        host.append(part);
        this.hostSlotHomes.push({ part, marker });
      }
    } else if (!on) {
      for (const { part, marker } of this.hostSlotHomes) {
        marker.replaceWith(part);
      }
      this.hostSlotHomes = [];
    }
    this.syncMenuHostSection();
  }

  /** The drawer's "From the page" section shows only when the host put something in one of its slots. */
  private syncMenuHostSection(): void {
    const section = this.rootNode.querySelector<HTMLElement>("[data-menu-host-section]");
    const host = this.rootNode.querySelector<HTMLElement>("[data-menu-host]");
    if (!section || !host) {
      return;
    }
    const filled =
      this.phone &&
      ([...host.querySelectorAll("slot")].some((slot) => slot.assignedElements({ flatten: true }).length > 0) || (this.modeActionsEl?.childElementCount ?? 0) > 0);
    section.hidden = !filled;
  }

  /** The count a workspace shows: the reported problems, and for Data the form's data-key clashes. */
  private workspaceCount(id: BuilderWorkspace): number {
    return (this.workspaceProblemsValue[id] ?? 0) + (id === "data" ? this.ctrl.dataKeyProblems().length : 0);
  }

  /** Brings the phone's parts up to date: the top row, the bottom bar, the sheet that is up. */
  private syncPhone(): void {
    if (!this.wrapEl || (!this.phone && !this.phoneTouched)) {
      return;
    }
    this.syncTopRow();
    this.syncBottomBar();
    this.syncSheets();
    if (!this.phone) {
      this.phoneTouched = false;
    }
  }

  /** The top row (spec 3.1): Menu named by the workspace and its problems, or a designer's back title. */
  private syncTopRow(): void {
    if (!this.phone || !this.wrapEl) {
      return;
    }
    const id = this.workspaceValue;
    const label = this.workspaceLabel(id);
    const count = this.workspaceCount(id);
    const button = this.rootNode.querySelector<HTMLElement>("[data-menu-open]");
    const labelEl = this.rootNode.querySelector<HTMLElement>("[data-menu-open-label]");
    const chip = this.rootNode.querySelector<HTMLElement>("[data-menu-open-count]");
    if (labelEl && labelEl.textContent !== label) {
      labelEl.textContent = label;
    }
    if (chip) {
      chip.hidden = count === 0;
      chip.textContent = count > 0 ? String(count) : "";
    }
    button?.setAttribute("aria-label", phoneMenuButtonName(label, count, this.words));
    button?.setAttribute("aria-expanded", String(this.menuOpen));
    const designer = this.activeMode.id !== PRIMARY_BUILDER_MODE;
    this.wrapEl.toggleAttribute("data-designer", designer);
    const back = this.rootNode.querySelector<HTMLElement>("[data-document-back]");
    if (!back) {
      return;
    }
    back.hidden = !designer;
    if (!designer) {
      return;
    }
    const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
    const name = active?.document?.label ?? this.modeLabel(this.activeMode);
    const kind = [active ? documentKind(this.activeMode, active.document, this.words) : "", active?.document?.isDefault === true ? this.words.text("shell.doc.default") : ""].filter(Boolean).join(" · ");
    const overview = this.words.text(isDesignerWorkspace(id) ? (id === "pdf" ? "shell.phone.place.layouts" : "shell.phone.place.journeys") : "shell.phone.place.overview");
    back.querySelector<HTMLElement>("[data-document-back-name]")!.textContent = name;
    back.querySelector<HTMLElement>("[data-document-back-kind]")!.textContent = kind;
    // The name is the visible title, then the hidden "Back to ..." (WCAG 2.5.3, Label in Name: the
    // visible words come first and in order, so no aria-label that rewrites them).
    back.querySelector<HTMLElement>("[data-document-back-place]")!.textContent = this.words.text("shell.phone.backPlace", { place: overview });
    back.title = this.words.text("shell.phone.backTitle", { place: overview });
  }

  /** What the bottom bar can hold, in the DOM's order: the rail's Add, the strip's items, the host's, Try it. */
  private bottomBarItems(): HTMLElement[] {
    const one = (selector: string): HTMLElement[] => {
      const found = this.rootNode.querySelector<HTMLElement>(selector);
      return found ? [found] : [];
    };
    return [...one("[data-rail-more]"), ...this.rootNode.querySelectorAll<HTMLElement>("[data-strip] [data-panel]"), ...this.hostStripItems(), ...one("[data-bottom-try]")];
  }

  private bottomKey(item: HTMLElement): string {
    if (item.dataset.railMore !== undefined) {
      return "add";
    }
    if (item.dataset.bottomTry !== undefined) {
      return "try";
    }
    if (item.getRootNode() !== this.rootNode) {
      return "host";
    }
    return item.dataset.panel ?? "host";
  }

  /**
   * The bottom bar (spec 3.4): the workspace's items in the phone's order, at most four, the rest
   * behind More. While trying the form, Results takes More's place. Script places them (an inline
   * order) and marks the overflow; everything else is the phone's CSS.
   */
  private syncBottomBar(): void {
    const items = this.bottomBarItems();
    const tryButton = this.rootNode.querySelector<HTMLElement>("[data-bottom-try]");
    const results = this.rootNode.querySelector<HTMLElement>("[data-bottom-results]");
    const more = this.rootNode.querySelector<HTMLElement>("[data-bottom-more]");
    const railMore = this.rootNode.querySelector<HTMLButtonElement>("[data-rail-more]");
    const components = this.rootNode.querySelector<HTMLElement>('[data-strip] [data-panel="components"]');
    for (const item of items) {
      item.style.removeProperty("order");
      if (item.hasAttribute("data-bottom-overflow") && item.getRootNode() !== this.rootNode) {
        item.style.removeProperty("display");
      }
      item.removeAttribute("data-bottom-overflow");
      item.toggleAttribute("data-bottom-item", this.phone && item.getRootNode() !== this.rootNode);
    }
    if (!tryButton || !results || !more) {
      return;
    }
    if (!this.phone) {
      tryButton.hidden = true;
      results.hidden = true;
      more.hidden = true;
      this.moreItems = [];
      if (railMore) {
        railMore.disabled = false;
        railMore.setAttribute("aria-label", this.words.text("shell.rail.all"));
      }
      components?.setAttribute("aria-label", this.words.text("components.title"));
      return;
    }
    // Try it on every canvas that has it: the Form's and a designer's open document.
    const tryable = this.canvasTryable();
    const trying = tryable && this.canvasEl?.previewing === true;
    tryButton.hidden = !tryable;
    tryButton.setAttribute("aria-pressed", String(trying));
    // Results are the Try it panel's phone form: no panel (the `try-it` feature left out), no Results.
    results.hidden = !trying || !this.featureEnabled("try-it");
    results.setAttribute("aria-expanded", String(this.resultsOpen));
    // The words on the bar are the names said (WCAG 2.5.3): the rail's button reads Add here.
    if (railMore) {
      railMore.disabled = trying;
      railMore.setAttribute("aria-label", this.words.text("shell.rail.label"));
      // The rail's one Tab stop is Add: the typed buttons it would otherwise rove to are not drawn here.
      for (const button of this.rootNode.querySelectorAll<HTMLElement>("[data-add-rail] button")) {
        button.tabIndex = button === railMore ? 0 : -1;
      }
    }
    components?.setAttribute("aria-label", this.words.text("shell.rail.label"));
    const railShown = this.rootNode.querySelector<HTMLElement>("[data-add-rail]")?.hidden === false;
    const shown = items
      .filter((item) => !item.hidden && !item.hasAttribute("data-out-of-workspace") && (item !== railMore || railShown))
      .sort((a, b) => (PHONE_BOTTOM_ORDER[this.bottomKey(a)] ?? PHONE_BOTTOM_ORDER.host!) - (PHONE_BOTTOM_ORDER[this.bottomKey(b)] ?? PHONE_BOTTOM_ORDER.host!));
    shown.forEach((item, index) => item.style.setProperty("order", String(index)));
    results.style.setProperty("order", "90");
    more.style.setProperty("order", "91");
    const room = trying || shown.length > PHONE_BOTTOM_BAR_MAX ? PHONE_BOTTOM_BAR_MAX - 1 : shown.length;
    const overflow = shown.slice(room);
    for (const item of overflow) {
      item.setAttribute("data-bottom-overflow", "");
      // A host's item is styled by the host: hidden inline, so no class of its own brings it back.
      if (item.getRootNode() !== this.rootNode) {
        item.style.setProperty("display", "none");
      }
    }
    this.moreItems = overflow;
    more.hidden = trying || overflow.length === 0;
    more.setAttribute("aria-expanded", String(this.moreOpen));
    if (more.hidden && this.moreOpen) {
      this.closeMore();
    }
  }

  /** The sheet up on a phone, if any; one at a time, in this order of precedence. */
  private currentSheet(): PhoneSheet | undefined {
    if (!this.phone || !this.wrapEl) {
      return undefined;
    }
    if (this.menuOpen) {
      return "menu";
    }
    if (this.moreOpen) {
      return "more";
    }
    if (this.resultsOpen) {
      return "results";
    }
    if ([...this.surfaceSheets].some((surface) => surface.isConnected && !surface.closest("[hidden]"))) {
      return "surface";
    }
    if (this.activePanel !== undefined) {
      return "side";
    }
    const workspace = this.workspaceValue;
    const inspectorShown =
      !this.propertiesEl.collapsed &&
      !this.wrapEl.hasAttribute("data-no-selection") &&
      !this.wrapEl.hasAttribute("data-trying") &&
      !this.wrapEl.hasAttribute("data-overview") &&
      workspace !== "logic" &&
      workspace !== "data" &&
      workspace !== "languages" &&
      workspace !== "print";
    return inspectorShown ? "props" : undefined;
  }

  /** Whether a framed sheet is at full height: the author raised it, or a small phone opens it so. */
  private sheetIsTall(key: string): boolean {
    return this.tallSheets.has(key) || (this.smallPhone && !this.shortSheets.has(key));
  }

  /** Raises or lowers the sheet that is up, remembered for this page. */
  private setSheetTall(tall: boolean): void {
    const key = this.sheetKey(this.sheetKind);
    if (tall) {
      this.shortSheets.delete(key);
      this.tallSheets.add(key);
    } else {
      this.tallSheets.delete(key);
      this.shortSheets.add(key);
    }
    this.syncSheets();
  }

  /** The key a sheet's height is remembered under, for this page only. */
  private sheetKey(kind: PhoneSheet | undefined): string {
    return kind === "side" ? `side:${this.activePanel ?? ""}` : (kind ?? "");
  }

  /**
   * Draws the sheet that is up (spec 3.5): the scrim, the handle row, its height, its dialog
   * semantics, everything behind it inert, and focus into it and back to what opened it.
   */
  private syncSheets(): void {
    const wrap = this.wrapEl;
    if (!wrap) {
      return;
    }
    const kind = this.currentSheet();
    const previous = this.sheetKind;
    this.sheetKind = kind;
    if (kind) {
      wrap.dataset.sheet = kind;
    } else {
      delete wrap.dataset.sheet;
    }
    const framed = kind === "side" || kind === "props";
    const head = this.rootNode.querySelector<HTMLElement>("[data-sheet-head]");
    const tall = framed && this.sheetIsTall(this.sheetKey(kind));
    wrap.toggleAttribute("data-sheet-tall", tall);
    if (head) {
      head.hidden = !framed;
      const grab = head.querySelector<HTMLElement>("[data-sheet-grab]");
      grab?.setAttribute("aria-expanded", String(tall));
      grab?.setAttribute("aria-label", this.words.text(tall ? "shell.sheet.grabTall" : "shell.sheet.grab"));
      head.querySelector<HTMLElement>("[data-sheet-close]")?.setAttribute("aria-label", kind === "props" ? this.words.text("shell.sheet.closeSettings") : this.words.text("shell.sheet.closeNamed", { name: this.sheetLabel() }));
    }
    // Dialog semantics while a sheet, the column's own role otherwise.
    const side = this.rootNode.querySelector<HTMLElement>("[data-side]");
    if (side) {
      if (kind === "side") {
        side.setAttribute("role", "dialog");
        side.setAttribute("aria-modal", "true");
        side.setAttribute("aria-label", this.sheetLabel());
      } else if (side.getAttribute("role") === "dialog") {
        side.setAttribute("role", "tabpanel");
        side.removeAttribute("aria-modal");
        side.removeAttribute("aria-label");
      }
    }
    const props = this.propertiesEl;
    if (props) {
      if (kind === "props") {
        props.setAttribute("role", "dialog");
        props.setAttribute("aria-modal", "true");
        props.setAttribute("aria-label", this.words.text("shell.sheet.settings"));
      } else if (props.getAttribute("role") === "dialog") {
        props.removeAttribute("role");
        props.removeAttribute("aria-modal");
        props.removeAttribute("aria-label");
      }
    }
    this.syncResultsSheet(kind === "results");
    this.syncSheetGestures(kind);
    this.syncDocumentLock();
    // Nothing behind the sheet is reachable (Focus Not Obscured): the scrim covers it, inert keeps the keys off it.
    const bar = this.rootNode.querySelector<HTMLElement>("[data-shell=bar]");
    const body = this.rootNode.querySelector<HTMLElement>(".body");
    const rails = this.rootNode.querySelector<HTMLElement>("[data-rails]");
    const hosts = [...this.rootNode.querySelectorAll<HTMLElement>(".logic-host")];
    const behind: Record<PhoneSheet, Array<HTMLElement | null | undefined>> = {
      menu: [bar, body],
      more: [bar, body],
      side: [bar, rails, this.canvasEl, props, ...hosts],
      props: [bar, rails, this.canvasEl, side, ...hosts],
      results: [bar, rails],
      surface: [bar, rails]
    };
    const inert = new Set(kind ? behind[kind] : []);
    for (const part of [bar, body, rails, side, props, this.canvasEl, ...hosts]) {
      if (part && part.hasAttribute("inert") !== inert.has(part)) {
        part.toggleAttribute("inert", inert.has(part));
      }
    }
    if (kind === previous) {
      return;
    }
    if (previous === undefined && kind !== undefined) {
      this.sheetOpener = this.deepActiveElement();
    }
    if (kind === "menu") {
      this.rootNode.querySelector<HTMLElement>("[data-menu-title]")?.focus({ preventScroll: true });
    } else if (kind === "more") {
      this.rootNode.querySelector<HTMLElement>("[data-more-title]")?.focus({ preventScroll: true });
    } else if (kind === "side" && side && !side.contains(this.rootNode.activeElement)) {
      side.focus({ preventScroll: true });
    } else if (kind === "results") {
      this.focusResultsSheet();
    } else if (kind === undefined && previous !== undefined) {
      const opener = this.sheetOpener;
      this.sheetOpener = undefined;
      this.returnFocus(opener);
    }
  }

  /**
   * Gives focus back after the last sheet goes: to what opened it, else (that is hidden now,
   * the tier having left the phone, or gone) to the nearest control the shell still draws,
   * so focus never falls to the page.
   */
  private returnFocus(opener: HTMLElement | undefined): void {
    const fallbacks = [
      this.phone ? "[data-menu-open]" : "[data-workspace-menu]",
      "[data-workspace-tab][aria-selected=true]",
      "[data-document-menu]",
      "[data-strip] [data-panel]"
    ].map((selector) => this.rootNode.querySelector<HTMLElement>(selector));
    for (const target of [opener, ...fallbacks]) {
      if (target?.isConnected && !target.closest("[inert]") && this.shownDeep(target)) {
        target.focus({ preventScroll: true });
        if (this.deepActiveElement() === target) {
          return;
        }
      }
    }
  }

  /** The Try it results sheet's own panel, in the canvas's shadow root (it is redrawn there, so asked for each time). */
  private resultsPanel(): HTMLElement | undefined {
    return this.canvasEl?.shadowRoot?.querySelector<HTMLElement>("[data-try-panel]") ?? undefined;
  }

  /** Moves focus into the results sheet, to its title (the same place Try again sends it). */
  private focusResultsSheet(): void {
    const focus = (): boolean => {
      const title = this.resultsPanel()?.querySelector<HTMLElement>("[data-try-sheet-title]");
      title?.focus({ preventScroll: true });
      return title !== undefined && title !== null && this.canvasEl.shadowRoot?.activeElement === title;
    };
    // The panel may only just have been shown: one more try on the next frame.
    if (!focus() && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.sheetKind === "results") {
          focus();
        }
      });
    }
  }

  /**
   * The results sheet as a dialog, like the other sheets: role, modal, its
   * title for a name (the catalog's words if the panel has no title yet), and its look adopted
   * into the canvas's shadow root, which the shell cannot style from outside.
   */
  private syncResultsSheet(on: boolean): void {
    const canvas = this.canvasEl;
    if (canvas) {
      // The grabber is drawn by the canvas, from these (it redraws the panel): height and words.
      canvas.toggleAttribute("data-results-tall", on && this.resultsTall);
      canvas.setAttribute("data-grab-label", this.words.text("shell.sheet.grab"));
      canvas.setAttribute("data-grab-label-tall", this.words.text("shell.sheet.grabTall"));
    }
    const panel = this.resultsPanel();
    if (!panel) {
      return;
    }
    const grab = panel.querySelector<HTMLElement>("[data-try-grab]");
    if (grab) {
      const tall = on && this.resultsTall;
      grab.setAttribute("aria-expanded", String(tall));
      grab.setAttribute("aria-label", this.words.text(tall ? "shell.sheet.grabTall" : "shell.sheet.grab"));
    }
    if (on) {
      const root = this.canvasEl.shadowRoot!;
      if (this.resultsSheetStyles === undefined && typeof CSSStyleSheet === "function") {
        try {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(RESULTS_SHEET_STYLES);
          this.resultsSheetStyles = sheet;
        } catch {
          // No constructable sheets here: the sheet keeps the canvas's own look, without the pill.
        }
      }
      const adopted = this.resultsSheetStyles;
      if (adopted && Array.isArray(root.adoptedStyleSheets) && !root.adoptedStyleSheets.includes(adopted)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, adopted];
      }
      const title = panel.querySelector<HTMLElement>("[data-try-sheet-title]");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", this.words.text(this.textKey("shell.sheet.results")));
      if (title) {
        title.id = title.id || "try-sheet-title";
        panel.setAttribute("aria-labelledby", title.id);
      }
    } else if (panel.getAttribute("role") === "dialog") {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
      panel.removeAttribute("aria-labelledby");
      panel.setAttribute("aria-label", this.words.text(this.textKey("shell.sheet.try")));
    }
  }

  /** Takes the gestures off the sheet they were on. */
  private disposeSheetGestures(): void {
    for (const off of this.sheetGestureOff) {
      off();
    }
    this.sheetGestureOff = [];
    this.sheetGestureKind = undefined;
  }

  /**
   * Drag, fling and swipe for the sheet that is up: attached when it
   * comes up, taken away when it goes. The handle row follows a drag by pointer events; a body
   * scrolled to its top follows a swipe down by touch events. Both end in the sheet's own
   * close path, so unapplied edits are asked about as they are for its Close button.
   */
  private syncSheetGestures(kind: PhoneSheet | undefined): void {
    if (kind === this.sheetGestureKind) {
      return;
    }
    this.disposeSheetGestures();
    this.sheetGestureKind = kind;
    const root = this.rootNode;
    const off = this.sheetGestureOff;
    const dismiss = (): void => this.closeSheet();
    if (kind === "side" || kind === "props") {
      const head = root.querySelector<HTMLElement>("[data-sheet-head]");
      const panel = kind === "side" ? root.querySelector<HTMLElement>("[data-side]") : this.propertiesEl;
      if (head && panel) {
        const common = {
          onDismiss: dismiss,
          onExpand: (): void => this.setSheetTall(true),
          onCollapse: (): void => this.setSheetTall(false),
          isExpanded: (): boolean => this.sheetIsTall(this.sheetKey(this.sheetKind)),
          follow: [head]
        };
        off.push(attachSheetGestures(panel, { ...common, handle: head, grab: head.querySelector<HTMLElement>("[data-sheet-grab]") }));
        off.push(attachSheetGestures(panel, { ...common, handle: panel, input: "touch" }));
      }
    } else if (kind === "more") {
      const sheet = root.querySelector<HTMLElement>("[data-more-sheet]");
      const head = sheet?.querySelector<HTMLElement>(".more-head");
      const list = sheet?.querySelector<HTMLElement>("[data-more-list]");
      if (sheet && head && list) {
        off.push(attachSheetGestures(sheet, { handle: head, onDismiss: dismiss }));
        off.push(attachSheetGestures(sheet, { handle: list, onDismiss: dismiss, input: "touch" }));
      }
    } else if (kind === "menu") {
      const drawer = root.querySelector<HTMLElement>("[data-menu-drawer]");
      if (drawer) {
        // Toward the edge it came from: left, or right in a right-to-left page.
        const rtl = typeof getComputedStyle === "function" && getComputedStyle(drawer).direction === "rtl";
        off.push(attachSheetGestures(drawer, { handle: drawer, onDismiss: dismiss, direction: rtl ? "right" : "left" }));
      }
    } else if (kind === "results") {
      // The sheet lives in the canvas's shadow root and is redrawn there: listen on the canvas, find the panel each time.
      const inPanel = (path: readonly EventTarget[]): boolean => path.some((node) => node instanceof Element && node.hasAttribute("data-try-panel"));
      const inHead = (path: readonly EventTarget[]): boolean => path.some((node) => node instanceof Element && node.classList.contains("try-sheet-head"));
      const onGrab = (path: readonly EventTarget[]): boolean => path.some((node) => node instanceof Element && node.hasAttribute("data-try-grab"));
      const elements = (): readonly HTMLElement[] => {
        const panel = this.resultsPanel();
        return panel ? [panel] : [];
      };
      const setTall = (tall: boolean): void => {
        this.resultsTall = tall;
        this.syncResultsSheet(true);
      };
      // The grabber is a real button: pointer events on it (touch-action none by its style), tap toggles tall, a drag down puts the sheet away, a drag up raises it.
      off.push(
        attachSheetGestures(this.canvasEl, {
          handle: this.canvasEl,
          elements,
          startFilter: (path) => inPanel(path) && onGrab(path),
          isGrab: onGrab,
          touchAction: null,
          isExpanded: () => this.resultsTall,
          onExpand: () => setTall(true),
          onCollapse: () => setTall(false),
          onDismiss: dismiss
        })
      );
      // Keyboard (and assistive) clicks on the grabber toggle too; a tap the gesture answered never gets here.
      const onClick = (event: Event): void => {
        if (onGrab(event.composedPath())) {
          setTall(!this.resultsTall);
        }
      };
      this.canvasEl.addEventListener("click", onClick);
      off.push(() => this.canvasEl.removeEventListener("click", onClick));
      off.push(
        attachSheetGestures(this.canvasEl, {
          handle: this.canvasEl,
          input: "touch",
          elements,
          startFilter: (path) => inPanel(path) && !onGrab(path),
          canDrag: (path) => inHead(path) || !sheetBodyScrolled(path, this.canvasEl),
          onDismiss: dismiss
        })
      );
    }
  }

  /** The open side panel's name, for its sheet's dialog and close button. */
  private sheetLabel(): string {
    const panel = SHELL_PANELS.find((entry) => entry.id === this.activePanel);
    if (panel) {
      return panelLabel(panel, this.words);
    }
    const hosted = this.hostPanels().find((element) => element.dataset.panel === this.activePanel);
    return hosted?.getAttribute("aria-label") ?? hosted?.dataset.panel ?? this.words.text("shell.sheet.panelFallback");
  }

  /** The element with focus, through every shadow root on the way down; the host's own light DOM too. */
  private deepActiveElement(): HTMLElement | undefined {
    let element: Element | null = this.rootNode.activeElement;
    if (!element) {
      const outside = document.activeElement;
      return outside && outside !== this && this.contains(outside) ? (outside as HTMLElement) : undefined;
    }
    while (element?.shadowRoot?.activeElement) {
      element = element.shadowRoot.activeElement;
    }
    return (element as HTMLElement | null) ?? undefined;
  }

  /** Puts away the sheet that is up, as its close button would: a panel or the inspector asks about unapplied edits first. */
  private closeSheet(): void {
    switch (this.sheetKind) {
      case "menu":
        this.closeMenu();
        return;
      case "more":
        this.closeMore();
        return;
      case "results":
        this.setResults(false);
        return;
      case "side":
        this.switchPanel(undefined);
        return;
      case "props":
        this.activeMode.controller.requestLeave(() => this.foldInspector(true));
        return;
      default:
        return;
    }
  }

  /** The phone's own controls; answers whether the click was one of theirs. */
  private onPhoneClick(has: (key: string) => HTMLElement | undefined): boolean {
    if (has("menuOpen")) {
      if (this.menuOpen) {
        this.closeMenu();
      } else {
        this.openMenu();
      }
      return true;
    }
    if (has("menuClose")) {
      this.closeMenu();
      return true;
    }
    const go = has("menuGo");
    if (go) {
      this.onMenuGo(go);
      return true;
    }
    const keep = has("menuRemoveKeep");
    if (keep) {
      const note = keep.closest("[data-remove-note]");
      (note?.previousElementSibling as HTMLElement | null)?.focus();
      note?.remove();
      return true;
    }
    if (has("scrim")) {
      this.closeSheet();
      return true;
    }
    if (has("documentBack")) {
      this.backToOverview();
      return true;
    }
    if (has("sheetGrab")) {
      // The handle by keyboard or a click without a pointer; a tap or a drag is the gestures' (sheet-gestures.ts).
      this.setSheetTall(!this.sheetIsTall(this.sheetKey(this.sheetKind)));
      return true;
    }
    if (has("sheetClose")) {
      this.closeSheet();
      return true;
    }
    if (has("moreClose")) {
      this.closeMore();
      return true;
    }
    const moreGo = has("moreGo");
    if (moreGo) {
      const item = this.moreItems[Number(moreGo.dataset.moreGo)];
      this.closeMore();
      // The item itself answers, as it would on the bar: a shell panel, a host's launcher.
      item?.click();
      return true;
    }
    if (has("bottomTry")) {
      this.toggleTryIt();
      return true;
    }
    if (has("bottomResults")) {
      this.setResults(!this.resultsOpen);
      return true;
    }
    if (has("bottomMore")) {
      if (this.moreOpen) {
        this.closeMore();
      } else {
        this.openMore();
      }
      return true;
    }
    return false;
  }

  /** Try it from the bottom bar or the drawer: unapplied edits are asked about first, as the canvas's own Try it does. */
  private toggleTryIt(): void {
    const canvas = this.canvasEl;
    if (canvas.previewing) {
      canvas.previewing = false;
      return;
    }
    this.activeMode.controller.requestLeave(() => {
      canvas.previewing = true;
    });
  }

  // --- The builder agent tools' seams ----------------------------
  //
  // What the builder agent's element host reaches the shell through: the canvas is private, so
  // revealing, highlighting and Try it go through these. Nothing in the shell calls them; on a
  // page without the agent they are never called and the canvas rule they rely on matches nothing.

  /**
   * Opens the step or tab that holds the component on the canvas, as the canvas does for a new
   * selection: through the previewed form's own `revealComponent`, which never moves focus. Does
   * nothing before the canvas has drawn a form.
   */
  public revealComponent(componentId: string): void {
    const renderer = this.canvasEl?.previewRoot()?.host as Partial<{ revealComponent(id: string): void }> | undefined;
    if (typeof renderer?.revealComponent === "function") {
      renderer.revealComponent(componentId);
    }
  }

  /**
   * Marks what an assistant's write touched: `data-agent-touched` on each of the
   * components' boxes in the canvas's previewed form for `ms`, drawn by the canvas chrome's rule
   * in the focus colour. In the edit view the box is the canvas's node chrome; while trying the
   * form, the form's own component and container elements. A paint inside the window that
   * replaces the boxes gets the mark again, once; a second call ends the first and starts over.
   */
  public highlightComponents(ids: readonly string[], ms = 1500): void {
    this.endAgentHighlight();
    const root = this.canvasEl?.previewRoot();
    if (!root || ids.length === 0) {
      return;
    }
    const wanted = new Set(ids);
    const selector = this.canvasEl.previewing ? "[data-component-id], [data-container-id]" : ".db-node[data-component-id]";
    // Sets the mark on every box of a touched component that lacks it; answers whether it set any.
    const mark = (): boolean => {
      let marked = false;
      for (const el of root.querySelectorAll<HTMLElement>(selector)) {
        const id = el.dataset.componentId ?? el.dataset.containerId;
        if (id !== undefined && wanted.has(id) && !el.hasAttribute("data-agent-touched")) {
          el.setAttribute("data-agent-touched", "");
          marked = true;
        }
      }
      return marked;
    };
    mark();
    let observer: MutationObserver | undefined;
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(() => {
        // The paint drew the boxes anew: mark them once more, then stop watching.
        if (mark()) {
          observer?.disconnect();
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    }
    const timer = setTimeout(() => this.endAgentHighlight(), ms);
    this.agentHighlight = { root, observer, timer };
  }

  /**
   * Whether the canvas shows the form being tried (Try it) rather than the edit view: the bottom
   * bar's own notion, so a canvas that cannot be tried on this workspace never reads as trying.
   */
  public get trying(): boolean {
    return this.canvasTryable() && (this.canvasEl?.previewing ?? false);
  }

  /**
   * Whether Try it can run on the page now: the gate every person's route to Try it
   * applies (the command, the bar's button, the phone menu), public so an assistant's host can
   * answer "not tryable" before it asks. False on Logic, Data, Languages and a designer overview.
   */
  public get tryable(): boolean {
    return this.canvasTryable();
  }

  /**
   * Turns Try it on or off, as the bottom bar's Try it does: off at once; on once unapplied edits
   * are answered, so with a draft open the shell asks the person first and Try it waits for the
   * answer. Answers whether the change happened now (also when there was nothing to change).
   * Never on where the person has no Try it: a workspace with no canvas would be left previewing
   * with no Back to editing, so that answers false and changes nothing.
   */
  public setTrying(on: boolean): boolean {
    const canvas = this.canvasEl as DatumBuilderCanvasElement | undefined;
    if (!canvas) {
      return false;
    }
    if (on && !this.canvasTryable()) {
      return false;
    }
    if (canvas.previewing === on) {
      return true;
    }
    if (!on) {
      canvas.previewing = false;
      return true;
    }
    return this.activeMode.controller.requestLeave(() => {
      canvas.previewing = true;
    });
  }

  /** Whether a strip panel is left off: by the `features` list or by `hidden-panels`. A host's own panels never are. */
  public panelHidden(id: string): boolean {
    return this.panelOff(id);
  }

  // Save, the preview's theme and language, Try it's parts and what Languages
  // lists. Each is what a person's control does or reads, minus the asking: an assistant never
  // raises a prompt, it is told what is in the way.

  /**
   * The host's Save as the File menu offers it, with the label the menu shows ("Save", "Save
   * draft"); `undefined` when the host lends none.
   *
   * @internal
   */
  public saveAvailable(): { label: string } | undefined {
    if (typeof this.fileActionsValue?.save !== "function") {
      return undefined;
    }
    return { label: this.fileActionsValue.saveLabel?.trim() || this.words.text("shell.file.save") };
  }

  /**
   * Save for a browser assistant: the File menu's Save without its unsaved-edits prompt. Where the
   * person's Save would ask first (a prompt already up, a draft on the selection or the form root,
   * an editor outside the tree holding edits: what `requestLeave` holds for, on the controller on
   * the page), this answers `held` and changes nothing, so the person's own answer is never
   * pre-empted; otherwise it runs the host's save as the person's does, with `trigger: "agent"` in
   * the save's context and the `builder-file-action` detail. Never New, Open or Download.
   *
   * @internal
   */
  public requestSave(): Promise<BuilderSaveOutcome> {
    if (typeof this.fileActionsValue?.save !== "function") {
      return Promise.resolve({ status: "no-save" });
    }
    const controller = this.activeController;
    const prompt = controller.unsavedChangesPrompt();
    if (prompt) {
      return Promise.resolve({ status: "held", reason: "prompt", componentId: prompt.componentId });
    }
    // The subjects `requestLeave` asks about, in its order: the selection's draft, then the root's.
    for (const subject of [controller.selectedComponentId(), controller.rootId()]) {
      if (subject !== undefined && controller.hasPendingChanges(subject)) {
        return Promise.resolve({ status: "held", reason: "draft", componentId: subject });
      }
    }
    if (controller.hasPendingLeaveGuard()) {
      const subject = controller.leaveGuardSubject();
      return Promise.resolve({ status: "held", reason: "leave-guard", ...(subject !== undefined ? { componentId: subject } : {}) });
    }
    return this.runSave("agent");
  }

  /**
   * Draws the canvas with one of the offered bindings, as the View panel's picker does: the
   * controller's binding **and** `builder-binding-change`, so the host hears it (`setBindingId`
   * alone does not, and ignores an unknown id without a word). `""` or `undefined` draws with the
   * host's own binding (else Datum's). Answers `false`, and changes nothing, for an id the builder
   * does not offer or when it offers none.
   *
   * Always the form's controller, whichever workspace is on the page: the host offers its
   * bindings to that one alone, and `describe_builder` lists them from it, so in Journeys or PDF
   * the answer agrees with what was offered.
   *
   * @internal
   */
  public setBindingForAgent(id: string | undefined): boolean {
    const controller = this.ctrl;
    const options = controller.availableBindings();
    if (options.length === 0) {
      return false;
    }
    if (options.some((option) => option.id === id)) {
      this.pickBinding(controller, id);
      return true;
    }
    if (id === undefined || id === "") {
      this.pickBinding(controller, undefined);
      return true;
    }
    return false;
  }

  /**
   * Shows the form in another of its languages, as the bar's language switcher does: the form's
   * controller moves, and Languages follows. The form itself is not changed.
   *
   * The form's controller even in Journeys or PDF, where the switcher is put away: moving only the
   * designer's own controller there would be half the picture (the View sync says so) and leave the
   * form where it was. A journey on the page shows the form's language, so its controller follows
   * too, now: the mode itself takes the form's language up only when it next brings the journey up
   * (activation, another journey), and the canvas the person sees must agree with the answer. As
   * the mode's own locale sync does it, silently with a repaint, which is no edit. A PDF layout
   * keeps the host's language, as it always does.
   *
   * @internal
   */
  public setPreviewLocale(code: string): void {
    this.followBarLocale(code, this.ctrl);
    const journey = this.activeMode.id === DESIGNER_WORKSPACES.journeys ? this.activeMode.controller : undefined;
    if (code && journey && journey !== this.ctrl && journey.currentLocale() !== code) {
      journey.setOptions({ locale: code }, { silent: true });
      journey.repaintPreview();
    }
  }

  /**
   * The canvas's Try it seams for the builder agent's element host (the canvas is private), or
   * `undefined` before the shell has drawn one. Each part reaches the canvas the shell has when it
   * is called, so a rebuilt shadow root is followed. `onTrySubmit` listens on the shell itself
   * (`builder-try-submit` bubbles and is composed): a listener bound to the canvas would stay on
   * the one a page move discards, and its unsubscriber would remove nothing from the new one.
   *
   * @internal
   */
  public agentTryParts(): BuilderAgentTryParts | undefined {
    if ((this.canvasEl as DatumBuilderCanvasElement | undefined) === undefined) {
      return undefined;
    }
    const canvas = (): DatumBuilderCanvasElement => this.canvasEl;
    return {
      triedRuntime: () => canvas().triedRuntime(),
      agentTryCheck: () => canvas().agentTryCheck(),
      agentTrySubmit: () => canvas().agentTrySubmit(),
      quietTriedPageFocus: () => canvas().quietTriedPageFocus(),
      focusedTriedPath: () => canvas().focusedTriedPath(),
      tryReady: () => canvas().tryReady(),
      tryPageIdOf: (nodeId) => canvas().tryPageIdOf(nodeId),
      tryNodeIdOf: (pageId) => canvas().tryNodeIdOf(pageId),
      tryRecording: () => canvas().tryRecording(),
      tryShowing: () => canvas().tryShowing(),
      tryServerChecks: () => canvas().tryServerChecks(),
      onTrySubmit: (listener) => {
        const heard = (event: Event): void => {
          listener((event as CustomEvent<Parameters<typeof listener>[0]>).detail);
        };
        this.addEventListener("builder-try-submit", heard);
        return () => this.removeEventListener("builder-try-submit", heard);
      },
      tryChunkState: () => canvas().tryChunkState()
    };
  }

  /**
   * What the Languages surface draws its rows from beside the form's controller, whether or not
   * the surface is on the page: the header and footer texts as the surface lists them, the
   * journeys' and the PDF layouts' texts (the same sources `feedLanguages` hands it), the host's
   * catalog, and `notLoaded`: a designer side the form holds documents for whose mode is not
   * registered, so its texts are missing from these lists. The element host cannot rebuild them,
   * since the header rows come from a shell-private module.
   *
   * @internal
   */
  public agentLanguageInputs(): BuilderAgentLanguageInputs {
    const words = this.words.options();
    const catalog = this.hostCatalogData();
    const whole = this.logicDefinitionSource?.();
    const notLoaded: Array<"journeys" | "pdf"> = [];
    if (!this.modeMap.has(DESIGNER_WORKSPACES.journeys) && readJourneys(whole).length > 0) {
      notLoaded.push("journeys");
    }
    if (!this.modeMap.has(DESIGNER_WORKSPACES.pdf) && (whole?.pdf?.layouts?.length ?? 0) > 0) {
      notLoaded.push("pdf");
    }
    return {
      extraTexts: this.languagesExtraTexts(words),
      pdfTexts: this.languagesPdfTexts(words),
      ...(catalog !== undefined ? { catalog } : {}),
      notLoaded
    };
  }

  /**
   * How many translations typed in Languages are not applied yet (the surface's `pendingCount`):
   * `0` when the surface has never been on the page.
   *
   * @internal
   */
  public agentLanguagesPending(): number {
    return this.languagesEl?.pendingCount ?? 0;
  }

  /**
   * The bar's language switcher, moved: the controller on the page follows (or `controller`, the
   * form's for {@link setPreviewLocale}), and Languages with it. The person's `locale-change`
   * listener keeps the default: it can also hear a composed `locale-change` from inside the canvas.
   */
  private followBarLocale(locale: string | undefined, controller: BuilderController = this.activeMode.controller): void {
    if (locale) {
      controller.setOptions({ locale });
      if (this.languagesEl) {
        this.languagesEl.locale = locale;
      }
    }
  }

  /** Takes the marks of the last {@link highlightComponents} away and stops its watch and its timer. */
  private endAgentHighlight(): void {
    const current = this.agentHighlight;
    if (!current) {
      return;
    }
    this.agentHighlight = undefined;
    clearTimeout(current.timer);
    current.observer?.disconnect();
    for (const el of current.root.querySelectorAll("[data-agent-touched]")) {
      el.removeAttribute("data-agent-touched");
    }
  }

  /** Try it's results as a sheet over the live form (spec 4.7). */
  private setResults(open: boolean): void {
    const next = open && this.phone && this.featureEnabled("try-it");
    if (next === this.resultsOpen) {
      return;
    }
    this.resultsOpen = next;
    this.canvasEl?.toggleAttribute("data-results-open", next);
    this.syncPhone();
  }

  /** A PDF page drawn to fit a phone's width: after the designer has drawn it. */
  private fitDesignerSoon(): void {
    setTimeout(() => {
      if (this.phone && this.activeMode.id !== PRIMARY_BUILDER_MODE) {
        // The canvas fits a fixed sheet wider than itself on its own; this is the
        // phone's nudge once the designer has drawn.
        this.canvasEl?.fitIfOverflowing();
      }
    }, 0);
  }

  // --- More: the bottom bar's overflow ----------------------------------

  private openMore(): void {
    const list = this.rootNode.querySelector<HTMLElement>("[data-more-list]");
    const sheet = this.rootNode.querySelector<HTMLElement>("[data-more-sheet]");
    if (!list || !sheet || !this.phone) {
      return;
    }
    list.innerHTML = this.moreItems
      .map((item, index) => {
        const label = item.getAttribute("aria-label") ?? item.getAttribute("title") ?? item.textContent?.trim() ?? "";
        const glyph =
          item.getRootNode() === this.rootNode
            ? (item.querySelector(".glyph")?.innerHTML ?? "")
            : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M4 4h16v16H4zM4 9h16"></path></svg>`;
        return `<button type="button" class="more-row" data-more-go="${index}"><span class="more-row-icon" aria-hidden="true">${glyph}</span><span class="more-row-label">${escapeHtml(label)}</span></button>`;
      })
      .join("");
    sheet.hidden = false;
    this.moreOpen = true;
    this.syncPhone();
  }

  private closeMore(): void {
    if (!this.moreOpen) {
      return;
    }
    this.moreOpen = false;
    this.rootNode.querySelector<HTMLElement>("[data-more-sheet]")?.toggleAttribute("hidden", true);
    this.syncPhone();
  }

  // --- the menu drawer (spec 3.6) ----------------------------------------

  private openMenu(): void {
    const drawer = this.rootNode.querySelector<HTMLElement>("[data-menu-drawer]");
    if (!drawer || !this.phone) {
      return;
    }
    this.closeMore();
    this.renderMenu();
    drawer.hidden = false;
    this.menuOpen = true;
    this.syncPhone();
  }

  private closeMenu(): void {
    if (!this.menuOpen) {
      return;
    }
    this.menuOpen = false;
    this.rootNode.querySelector<HTMLElement>("[data-menu-drawer]")?.toggleAttribute("hidden", true);
    this.syncPhone();
  }

  /** Draws the drawer's head and sections from the shell as it stands. */
  private renderMenu(): void {
    const title = this.rootNode.querySelector<HTMLElement>("[data-menu-title]");
    const state = this.rootNode.querySelector<HTMLElement>("[data-menu-state]");
    const sections = this.rootNode.querySelector<HTMLElement>("[data-menu-sections]");
    if (!title || !state || !sections) {
      return;
    }
    title.textContent = this.modeTabLabel(this.modeMap.get(PRIMARY_BUILDER_MODE)!);
    const saved = this.saveStateValue === "unsaved" ? this.words.text("shell.menu.unsaved") : this.saveStateValue === "saved" ? this.words.text("shell.menu.saved") : "";
    state.textContent = saved;
    state.hidden = saved === "";
    sections.innerHTML = phoneMenuSectionsHtml(this.phoneMenuSections(), this.words);
    this.syncMenuHostSection();
  }

  /** What the drawer lists (spec 3.6): workspaces, the designer's documents, the canvas, files, tools. */
  private phoneMenuSections(): PhoneMenuSection[] {
    const workspace = this.workspaceValue;
    const controller = this.activeMode.controller;
    const sections: PhoneMenuSection[] = [
      {
        id: "workspaces",
        heading: this.words.text("shell.menu.workspaces"),
        rows: this.availableWorkspaces().map((id) => ({
          go: `workspace:${id}`,
          label: this.workspaceLabel(id),
          icon: PHONE_MENU_ICONS[id],
          current: id === workspace,
          count: this.workspaceCount(id)
        }))
      }
    ];
    // A designer workspace lists its documents, and the one on the page its options (the overview stays one tap away).
    if (isDesignerWorkspace(workspace)) {
      const mode = this.modeMap.get(DESIGNER_WORKSPACES[workspace]);
      const documents = mode?.documents;
      const open = mode && this.activeMode === mode ? documents?.selectedId() : undefined;
      const noun = mode ? documentNoun(mode, undefined, this.words) : this.words.text("shell.doc.noun");
      const rows: PhoneMenuRow[] = (documents?.list() ?? []).map((document) => ({
        go: "document",
        label: document.label,
        icon: PHONE_MENU_ICONS.document,
        current: document.id === open,
        chip: document.isDefault === true ? this.words.text("shell.doc.default") : document.badge,
        attributes: { "data-menu-mode": mode!.id, "data-menu-document": document.id }
      }));
      if (this.activeMode !== this.modeMap.get(PRIMARY_BUILDER_MODE)) {
        rows.push({ go: "overview", label: this.words.text(workspace === "pdf" ? "shell.menu.allLayouts" : "shell.menu.allJourneys"), icon: PHONE_MENU_ICONS.overview });
      }
      sections.push({ id: "documents", heading: this.words.text(workspace === "pdf" ? "shell.menu.layouts" : "shell.menu.journeys"), rows });
      const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
      if (mode && this.activeMode === mode && active?.document && documents) {
        const list = documents.list();
        const place = list.findIndex((document) => document.id === active.document!.id);
        const actions: PhoneMenuRow[] = [];
        if (documents.rename) actions.push({ go: "docaction:rename", label: this.words.text("shell.doc.rename"), icon: PHONE_MENU_ICONS.rename });
        if (documents.duplicate) actions.push({ go: "docaction:duplicate", label: this.words.text("shell.doc.duplicate"), icon: PHONE_MENU_ICONS.duplicate });
        if (documents.move) {
          actions.push({ go: "docaction:move-up", label: this.words.text("shell.doc.moveUp"), icon: PHONE_MENU_ICONS.up, disabled: place <= 0 });
          actions.push({ go: "docaction:move-down", label: this.words.text("shell.doc.moveDown"), icon: PHONE_MENU_ICONS.down, disabled: place < 0 || place >= list.length - 1 });
        }
        if (documents.setDefault) actions.push({ go: "docaction:default", label: this.words.text("shell.doc.setDefault"), icon: PHONE_MENU_ICONS.star, disabled: active.document.isDefault === true });
        if (documents.remove) actions.push({ go: "docaction:remove", label: this.words.text("shell.doc.delete"), icon: PHONE_MENU_ICONS.delete, danger: true });
        sections.push({ id: "document", heading: this.words.text("shell.menu.thisDocument", { noun }), rows: actions });
      }
    }
    const canvasRows: PhoneMenuRow[] = [];
    const formCanvas = workspace === "form" && this.activeMode.id === PRIMARY_BUILDER_MODE;
    const designer = this.activeMode.id !== PRIMARY_BUILDER_MODE;
    // A designer's document is tried too; its zoom rows follow.
    if (this.canvasTryable()) {
      const trying = this.canvasEl.previewing;
      canvasRows.push({ go: "try", label: this.words.text(trying ? "shell.menu.backToEditing" : this.textKey("shell.menu.tryIt")), icon: PHONE_MENU_ICONS.try });
      if (trying && this.featureEnabled("try-it")) {
        canvasRows.push({ go: "panel:settings", label: this.words.text("shell.menu.trySettings"), icon: PHONE_MENU_ICONS.settings });
      }
    }
    if (formCanvas || designer) {
      canvasRows.push({ go: "show-hidden", label: this.words.text("shell.menu.showHidden"), icon: PHONE_MENU_ICONS.hidden, checked: controller.showHiddenComponents() });
    }
    if (designer && controller.sheetWidth() !== undefined) {
      canvasRows.push({ go: "zoom:in", label: this.words.text("shell.menu.zoomIn"), icon: PHONE_MENU_ICONS.zoomIn });
      canvasRows.push({ go: "zoom:out", label: this.words.text("shell.menu.zoomOut"), icon: PHONE_MENU_ICONS.zoomOut });
      canvasRows.push({ go: "zoom:fit", label: this.words.text("shell.menu.fit"), icon: PHONE_MENU_ICONS.fit });
    }
    sections.push({ id: "canvas", heading: this.words.text("shell.menu.canvas"), rows: canvasRows });
    const supplied = this.suppliedFileActions();
    const apple = isApplePlatform();
    sections.push({
      id: "file",
      heading: this.words.text("shell.menu.file"),
      rows: [
        ...(supplied.save ? [{ go: "file:save", label: this.words.text("shell.file.save"), icon: PHONE_MENU_ICONS.save, ...(this.coarsePointer ? {} : { shortcut: apple ? "⌘S" : "Ctrl+S" }) }] : []),
        ...(supplied.new ? [{ go: "file:new", label: this.words.text("shell.file.new"), icon: PHONE_MENU_ICONS.new }] : []),
        ...(supplied.open ? [{ go: "file:open", label: this.words.text("shell.file.open"), icon: PHONE_MENU_ICONS.open }] : []),
        ...(supplied.download ? [{ go: "file:download", label: this.words.text("shell.file.download"), icon: PHONE_MENU_ICONS.download }] : [])
      ]
    });
    const fullWindowOffered = this.fullWindow || !this.hasAttribute("no-full-window");
    sections.push({
      id: "tools",
      heading: this.words.text("shell.menu.tools"),
      rows: [
        ...(this.featureEnabled("palette")
          ? [{ go: "search", label: this.words.text("shell.menu.search"), icon: PHONE_MENU_ICONS.search, ...(this.coarsePointer ? {} : { shortcut: apple ? "⌘K" : "Ctrl+K" }) }]
          : []),
        ...(fullWindowOffered
          ? [{ go: "full-window", label: this.words.text(this.fullWindow ? "shell.bar.leaveFullWindow" : "shell.bar.fullWindow"), icon: this.fullWindow ? PHONE_MENU_ICONS.leaveFullWindow : PHONE_MENU_ICONS.fullWindow }]
          : []),
        ...(this.schemeToggleOffered()
          ? [{ go: "scheme", label: this.words.text(this.scheme === "dark" ? "shell.menu.lightMode" : "shell.menu.darkMode"), icon: this.scheme === "dark" ? PHONE_MENU_ICONS.lightMode : PHONE_MENU_ICONS.darkMode }]
          : [])
      ]
    });
    return sections;
  }

  /** A drawer row: a switch and a first Delete keep the drawer up; everything else puts it away, then runs. */
  private onMenuGo(row: HTMLElement): void {
    const go = row.dataset.menuGo ?? "";
    const at = go.indexOf(":");
    const verb = at < 0 ? go : go.slice(0, at);
    const argument = at < 0 ? "" : go.slice(at + 1);
    if (verb === "show-hidden") {
      const controller = this.activeMode.controller;
      controller.setShowHiddenComponents(!controller.showHiddenComponents());
      this.renderMenu();
      this.rootNode.querySelector<HTMLElement>('[data-menu-go="show-hidden"]')?.focus();
      return;
    }
    if (verb === "docaction" && argument === "remove" && row.dataset.confirm === undefined) {
      // Asked in place, under the row (see removeNoteHtml); the drawer stays up meanwhile.
      const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
      if (active?.document && !row.nextElementSibling?.hasAttribute("data-remove-note")) {
        row.insertAdjacentHTML("afterend", this.removeNoteHtml(active.mode, active.document, "data-menu-go=\"docaction:remove\"", "data-menu-remove-keep"));
      }
      row.nextElementSibling?.querySelector<HTMLElement>("[data-menu-remove-keep]")?.focus();
      return;
    }
    const opener = this.rootNode.querySelector<HTMLElement>("[data-menu-open]") ?? row;
    this.closeMenu();
    switch (verb) {
      case "scheme":
        // Dark mode / Light mode: the other scheme, the drawer put away like any action,
        // and focus back on the button that opened it (the row went with the drawer).
        this.toggleScheme();
        opener.focus();
        return;
      case "workspace":
        if (isWorkspace(argument)) {
          this.setWorkspace(argument);
        }
        return;
      case "document": {
        const mode = row.dataset.menuMode;
        const id = row.dataset.menuDocument;
        if (mode && id !== undefined && this.modeMap.has(mode)) {
          this.selectDocument(mode, id);
        }
        return;
      }
      case "overview":
        this.backToOverview();
        return;
      case "docaction":
        this.runPhoneDocumentAction(argument);
        return;
      case "try":
        this.toggleTryIt();
        return;
      case "panel":
        if (STRIP_PANEL_IDS.has(argument)) {
          this.switchPanel(argument as DatumBuilderPanel);
        }
        return;
      case "zoom": {
        const zoom = this.canvasEl.zoom;
        this.canvasEl.zoomTo(argument === "in" ? zoom * 1.25 : argument === "out" ? zoom / 1.25 : "fit-width");
        return;
      }
      case "file":
        if (argument === "save") {
          this.fileSave();
        } else if (argument === "new") {
          this.fileNew(opener);
        } else if (argument === "open") {
          this.fileOpen();
        } else if (argument === "download") {
          this.fileDownload();
        }
        return;
      case "search":
        void this.openPalette();
        return;
      case "full-window":
        this.fullWindow = !this.fullWindow;
        opener.focus();
        return;
      default:
        return;
    }
  }

  /** The drawer's options for the document on the page: the bar's document menu, on a phone. */
  private runPhoneDocumentAction(action: string): void {
    const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
    const documents = active?.document ? active.mode.documents : undefined;
    if (!active?.document || !documents) {
      return;
    }
    const mode = active.mode;
    const id = active.document.id;
    switch (action) {
      case "rename":
        // The rename box takes the top row while it is up (the phone's CSS shows it there).
        this.renaming = { mode, id };
        this.renderDocuments();
        return;
      case "duplicate":
        mode.controller.requestLeave(() => documents.duplicate?.(id));
        return;
      case "default":
        documents.setDefault?.(id);
        return;
      case "move-up":
      case "move-down":
        documents.move?.(id, action === "move-up" ? -1 : 1);
        return;
      case "remove":
        mode.controller.requestLeave(() => documents.remove?.(id));
        return;
      default:
        return;
    }
  }

  // --- remembered panels and the narrow layout ---------------

  /** Puts back the layout remembered under the key, if any: widths first, then the panel and the inspector's fold. */
  private restorePanels(): void {
    if (!this.persistKey || !this.wrapEl) {
      return;
    }
    const memory = readPanelMemory(this.persistKey);
    if (!memory) {
      return;
    }
    // A layout the author left behind is their choice, the palette's state in it included, except that a
    // record naming no panel is what the shell writes while its own palette rule stands and a drawer
    // width or the folded inspector is stored (savePanels): the palette stays the shell's to settle.
    this.autoPalette = memory.panel === null;
    this.restoring = true;
    try {
      if (memory.sideWidth !== undefined) {
        this.wrapEl.style.setProperty("--db-side-w", `${memory.sideWidth}px`);
      }
      if (memory.propsWidth !== undefined) {
        this.wrapEl.style.setProperty("--db-props-w", `${memory.propsWidth}px`);
      }
      const panel = memory.panel ?? undefined;
      // A Tests panel put back open skips its opening run: a page load never runs a suite by itself.
      // Consumed when the panel is wired; dropped below when the panel is not the one that ends up open.
      this.testsRestored = panel === "tests";
      // A chunk already on the page wired the panel while the markup was drawn, before this ran: tell that one now, still hidden.
      if (this.testsRestored && this.testsPanelEl) {
        (this.testsPanelEl as unknown as { restored?: boolean }).restored = true;
        this.testsRestored = false;
      }
      if (memory.workspace && this.availableWorkspaces().includes(memory.workspace)) {
        this.workspaceValue = memory.workspace;
        this.lastFormWorkspace = memory.workspace;
        this.workspaceRestored = true;
      }
      if (this.narrow) {
        // Applied when the shell widens; the drawers stay put away for now.
        this.wideState = { panel, propsCollapsed: memory.propsCollapsed };
      } else {
        this.setPanel(panel);
        this.foldInspector(memory.propsCollapsed);
        if (this.activePanel !== "tests") {
          this.testsRestored = false;
        }
      }
    } finally {
      this.restoring = false;
    }
  }

  /** Writes the panels as they stand under the key; a narrow shell writes nothing, its drawers being a passing state. */
  private savePanels(): void {
    if (!this.persistKey || !this.wrapEl || !this.panelsReady || this.narrow || this.restoring || this.passing || (this.medium && this.yieldedProps)) {
      return;
    }
    const width = (name: string): number | undefined => {
      const value = parseInt(this.wrapEl.style.getPropertyValue(name), 10);
      return Number.isFinite(value) ? value : undefined;
    };
    /*
     * Only the shell's own panels are remembered, not a host's own panel, which may not be
     * slotted next time.
     */
    const open = this.activePanel;
    // The palette the shell opened or shut by its own rule is not the author's choice:
    // nothing is written for it, so the next visit decides again by the form it finds.
    const remembered = this.autoPalette ? null : (REMEMBERED_PANELS.find((candidate) => candidate === open) ?? null);
    const memory: PanelMemory = {
      panel: remembered,
      propsCollapsed: this.propertiesEl.collapsed,
      workspace: this.lastFormWorkspace
    };
    const sideWidth = width("--db-side-w");
    if (sideWidth !== undefined) {
      memory.sideWidth = sideWidth;
    }
    const propsWidth = width("--db-props-w");
    if (propsWidth !== undefined) {
      memory.propsWidth = propsWidth;
    }
    if (this.autoPalette && sideWidth === undefined && propsWidth === undefined && !memory.propsCollapsed && memory.workspace === "form") {
      return;
    }
    writePanelMemory(this.persistKey, memory);
  }

  /** Follows the wrap's width: a ResizeObserver where there is one, the window's resize otherwise (and in jsdom). */
  private watchWidth(): void {
    this.widthObserver?.disconnect();
    if (typeof ResizeObserver === "function") {
      this.widthObserver = new ResizeObserver(() => {
        this.syncNarrow();
      });
      this.widthObserver.observe(this.wrapEl);
    }
    window.addEventListener("resize", this.onWindowResize);
    this.syncNarrow();
  }

  private readonly onWindowResize = (): void => {
    this.syncNarrow();
  };

  /** Reads the wrap's width and moves between the wide and the narrow layout when it crosses the line. */
  private syncNarrow(): void {
    if (!this.wrapEl) {
      return;
    }
    const box = this.wrapEl.getBoundingClientRect();
    const width = box.width;
    // A phone on its side is wider than a phone but no taller than one: a short coarse-pointer viewport stays a phone.
    const phone = width > 0 && (width < PHONE_MAX || this.shortCoarseViewport());
    const narrow = width > 0 && (width < NARROW_MAX || phone);
    const medium = !phone && width >= NARROW_MAX && width < 1280;
    const small = phone && (width < PHONE_SMALL_WIDTH || (box.height > 0 && box.height < PHONE_SMALL_HEIGHT));
    if (medium !== this.medium) {
      this.medium = medium;
      this.yieldedProps = false;
    }
    if (narrow !== this.narrow) {
      this.applyNarrow(narrow);
    }
    // A touch screen has no keyboard to hint at: CSS reads data-pointer, and the token carries it into the panels' shadow roots.
    this.setPointer(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    // Inside narrow: the drawers are already put away when a phone comes up.
    this.setPhone(phone);
    if (small !== this.smallPhone) {
      this.smallPhone = small;
      // The inspector's sheet is tall by default here: redraw the sheet that is up.
      this.syncPhone();
    }
    // The shell's box, not the window, sizes what the popovers may take.
    if (width > 0) {
      this.shellWidth = width;
      this.applyShellWidth();
    }
    // A tight bar drops the document face's chips.
    this.wrapEl.toggleAttribute("data-bar-tight", width > 0 && width < 1100);
  }

  /** Whether the primary pointer is coarse (a finger): keyboard and drag hints are hidden then. */
  private coarsePointer = false;

  /** Sets `data-pointer` on the shell and `--db-hint-display`, which the panels' hint rules read. */
  private setPointer(coarse: boolean): void {
    if (!this.wrapEl) {
      return;
    }
    this.coarsePointer = coarse;
    this.wrapEl.setAttribute("data-pointer", coarse ? "coarse" : "fine");
    if (coarse) {
      this.wrapEl.style.setProperty("--db-hint-display", "none");
    } else {
      this.wrapEl.style.removeProperty("--db-hint-display");
    }
  }

  /** Whether the window is short and touched, the way a phone held sideways is (a desktop window never is). */
  private shortCoarseViewport(): boolean {
    if (typeof window.matchMedia !== "function" || !(window.innerHeight > 0) || window.innerHeight >= PHONE_SHORT_MAX) {
      return false;
    }
    return window.matchMedia("(pointer: coarse)").matches;
  }

  private applyNarrow(narrow: boolean): void {
    if (narrow) {
      // Going narrow: keep what the author had, then put both drawers away for the canvas.
      this.wideState = { panel: this.activePanel, propsCollapsed: this.propertiesEl.collapsed };
      this.narrow = true;
      this.wrapEl.toggleAttribute("data-narrow", true);
      this.setPanel(undefined);
      this.foldInspector(true);
    } else {
      this.narrow = false;
      this.wrapEl.toggleAttribute("data-narrow", false);
      const wide = this.wideState;
      this.wideState = undefined;
      if (wide) {
        // The fold first: setPanel writes the record, and must see the inspector as it will be.
        this.foldInspector(wide.propsCollapsed);
        this.setPanel(wide.panel);
      }
    }
  }

  // --- the document tabs ---------------------------------------------

  /** The tabs the bar shows, in order: each mode's documents, or the mode itself. Hidden modes are left out. */
  private documentTabs(): Array<{ mode: BuilderMode; document?: BuilderDocument }> {
    const tabs: Array<{ mode: BuilderMode; document?: BuilderDocument }> = [];
    for (const mode of this.modeMap.values()) {
      if (this.hiddenModes.has(mode.id)) {
        continue;
      }
      const list = mode.documents?.list() ?? [];
      if (list.length > 0) {
        for (const document of list) {
          tabs.push({ mode, document });
        }
      } else {
        // A mode without documents is one entry, its label — so is one whose list is empty,
        // which is still a place to go, and names the face while it is on the page.
        tabs.push({ mode });
      }
    }
    return tabs;
  }

  /**
   * What a mode's own tab says. The builder's own tree is the *form*, so its tab carries the
   * form's title — an author with a form and three PDF layouts on the bar reads four document
   * names, not "Form" and three. The title is taken drafted, so the tab follows what is being
   * typed the way the canvas does, and falls back to the mode's label while the form has no
   * title yet. Another mode's tab keeps its own label.
   */
  private modeTabLabel(mode: BuilderMode): string {
    if (mode.id !== PRIMARY_BUILDER_MODE) {
      return this.modeLabel(mode);
    }
    const controller = mode.controller;
    // The drafted title is a string in the default language; the tab words it for the preview language.
    const drafted = controller.draftProperty(controller.rootId(), "title");
    const title =
      typeof drafted === "string" && drafted.length > 0
        ? resolveText(drafted, addressOf.form("title"), controller.currentLocale(), { translations: controller.translations(), catalog: controller.translationCatalog() })
        : "";
    return title.trim().length > 0 ? title.trim() : this.modeLabel(mode);
  }

  private isTabSelected(tab: { mode: BuilderMode; document?: BuilderDocument }): boolean {
    if (tab.mode !== this.activeMode) {
      return false;
    }
    return tab.document === undefined || tab.document.id === tab.mode.documents?.selectedId();
  }

  private renderDocuments(): void {
    const container = this.documentsEl;
    if (!container) {
      return;
    }
    const tabs = this.documentTabs();
    const active = tabs.find((tab) => this.isTabSelected(tab));
    const hidden = !this.showModeSwitchValue || !active;
    // A page that lays out its own switch (showModeSwitch off) still gets the way back out of a designer: only the document's face goes.
    const backOnly = hidden && !!active && isDesignerWorkspace(this.workspaceValue) && !this.onOverview();
    const documents = active?.document ? active.mode.documents : undefined;
    const hasOptions = !!documents && !!(documents.rename || documents.duplicate || documents.remove || documents.setDefault || documents.move);
    /*
     * The form's label carries the form's title, so this runs on every controller change —
     * every keystroke of a property edit among them. Repaint only when something the label
     * shows moved, as the outline does: rebuilding it under an author mid-rename
     * would take the caret with it.
     */
    const signature = JSON.stringify([
      hidden,
      backOnly,
      hasOptions,
      this.renaming ? [this.renaming.mode.id, this.renaming.id] : null,
      active
        ? [active.mode.id, active.document?.id ?? null, active.document?.label ?? this.modeTabLabel(active.mode), active.document?.isDefault ?? null, active.document?.badge ?? null]
        : null,
      this.textLocaleValue ?? null
    ]);
    if (signature === this.documentsSignature) {
      return;
    }
    this.documentsSignature = signature;
    container.hidden = hidden && !backOnly;
    const wrap = container.querySelector<HTMLElement>("[data-document-picker-wrap]")!;
    wrap.hidden = hidden;
    const activeLabel = active ? (active.document?.label ?? this.modeTabLabel(active.mode)) : "";
    // Rename edits the document on the page (the menu is its), in the label's place.
    const renaming = !!this.renaming && !!active?.document && this.renaming.mode === active.mode && this.renaming.id === active.document.id;
    if (this.renaming && !renaming) {
      this.renaming = undefined;
    }
    if (!hasOptions && this.documentMenuOpener === "menu") {
      this.closeDocumentMenu();
    }
    // The words for the document on the page are its mode's: "Layout name", "Journey options" — or the document's own word.
    const activeNoun = capitalized(active ? documentNoun(active.mode, active.document, this.words) : this.words.text("shell.doc.noun"));
    // A mode with no document yet is named by its label alone ("Journeys"): there is no document to have a kind.
    const kind = active && (active.document || active.mode.id === PRIMARY_BUILDER_MODE) ? documentKind(active.mode, active.document, this.words) : "";
    // A badge that only repeats the kind (say, a "Journey" badge on a journey) is said once, as the kind.
    const badge = active?.document?.badge?.trim();
    const badges = [...(active?.document?.isDefault === true ? [this.words.text("shell.doc.default")] : []), ...(badge && badge !== kind ? [badge] : [])];
    const inner = `<span class="document-face-name" data-document-picker-name title="${escapeHtml(activeLabel)}">${escapeHtml(activeLabel)}</span>${kind ? `<span class="document-face-type" data-document-kind title="${escapeHtml(kind)}">${escapeHtml(kind)}</span>` : ""}${badges
      .map((badge) => `<span class="document-face-badge" title="${escapeHtml(badge)}">${escapeHtml(badge)}</span>`)
      .join("")}`;
    const open = this.documentMenuOpener === "menu" && !this.documentMenuEl().hidden;
    wrap.innerHTML = renaming
      ? `<input class="document-rename" data-document-rename value="${escapeHtml(activeLabel)}" aria-label="${escapeHtml(this.words.text("shell.doc.name", { noun: activeNoun }))}" />`
      : hasOptions
        ? `<button type="button" class="document-face" data-document-face data-document-menu aria-haspopup="menu" aria-expanded="${open}" title="${escapeHtml(this.words.text("shell.doc.options", { noun: activeNoun }))}">${inner}</button>`
        : `<span class="document-face" data-document-face title="${escapeHtml(activeLabel)}">${inner}</span>`;
    if (renaming) {
      const box = wrap.querySelector<HTMLInputElement>("[data-document-rename]");
      box?.focus();
      box?.select();
    }
    this.syncTopRow();
  }

  /** Marks the label busy while a switch is under way; the repaint that follows a success clears it. */
  private setDocumentFaceBusy(busy: boolean): void {
    const face = this.rootNode?.querySelector<HTMLElement>("[data-document-face]");
    if (busy) {
      face?.setAttribute("aria-busy", "true");
    } else {
      face?.removeAttribute("aria-busy");
    }
  }

  private documentMenuEl(): HTMLElement {
    return this.documentsEl.querySelector<HTMLElement>("[data-document-menu-popover]")!;
  }

  private toggleDocumentMenu(): void {
    const menu = this.documentMenuEl();
    if (!menu.hidden) {
      this.closeDocumentMenu();
      return;
    }
    this.closeFileMenu();
    const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
    const documents = active?.document ? active.mode.documents : undefined;
    if (!active?.document || !documents) {
      return;
    }
    const item = (action: string, label: string, disabled = false, describedBy?: string): string =>
      `<button type="button" class="menu-item" role="menuitem" data-document-action="${action}"${disabled ? " disabled" : ""}${describedBy ? ` aria-describedby="${describedBy}"` : ""}>${label}</button>`;
    // Where the document stands among its mode's: Move up and Move down are off at the ends.
    const place = documents.move ? documents.list().findIndex((document) => document.id === active.document!.id) : -1;
    const count = documents.move ? documents.list().length : 0;
    // Its place, read with each move item: the menu comes back after a move with focus on the
    // item again, so a screen reader hears where the document now stands.
    const placeNote =
      documents.move && place >= 0
        ? `<span id="document-place-note" data-document-place hidden>${escapeHtml(this.words.text("shell.doc.place", { name: active.document.label, noun: documentNoun(active.mode, active.document, this.words), place: place + 1, count }))}</span>`
        : "";
    menu.setAttribute("role", "menu");
    menu.innerHTML = [
      documents.rename ? item("rename", escapeHtml(this.words.text("shell.doc.rename"))) : "",
      documents.duplicate ? item("duplicate", escapeHtml(this.words.text("shell.doc.duplicate"))) : "",
      documents.move ? item("move-up", escapeHtml(this.words.text("shell.doc.moveUp")), place <= 0, placeNote ? "document-place-note" : undefined) : "",
      documents.move ? item("move-down", escapeHtml(this.words.text("shell.doc.moveDown")), place < 0 || place >= count - 1, placeNote ? "document-place-note" : undefined) : "",
      documents.setDefault ? item("default", escapeHtml(this.words.text("shell.doc.setDefault")), active.document.isDefault === true) : "",
      documents.remove ? item("remove", escapeHtml(this.words.text("shell.doc.delete"))) : "",
      placeNote
    ].join("");
    menu.setAttribute("aria-label", this.words.text("shell.doc.options", { noun: capitalized(documentNoun(active.mode, active.document, this.words)) }));
    menu.hidden = false;
    this.documentMenuOpener = "menu";
    this.rootNode.querySelector<HTMLElement>("[data-document-menu]")?.setAttribute("aria-expanded", "true");
    menu.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    window.addEventListener("click", this.onWindowClick);
  }

  private closeDocumentMenu(): void {
    const menu = this.documentMenuEl();
    if (!menu || menu.hidden) {
      return;
    }
    menu.hidden = true;
    menu.innerHTML = "";
    this.rootNode.querySelector<HTMLElement>("[data-document-menu]")?.setAttribute("aria-expanded", "false");
    this.documentMenuOpener = undefined;
    window.removeEventListener("click", this.onWindowClick);
  }

  /** A click outside the shell entirely takes the document's menu down. */
  private readonly onWindowClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    if (!path.includes(this)) {
      this.closeDocumentMenu();
    }
  };

  /** The file menu goes on any click outside it, in the builder or on the page; heard only while it is open. */
  private readonly onFileMenuOutside = (event: MouseEvent): void => {
    const group = this.rootNode?.querySelector("[data-file-actions]");
    if (!group || !event.composedPath().includes(group)) {
      this.closeFileMenu();
    }
  };

  private runDocumentAction(button: HTMLElement): void {
    const active = this.documentTabs().find((tab) => this.isTabSelected(tab));
    const documents = active?.document ? active.mode.documents : undefined;
    if (!active?.document || !documents) {
      this.closeDocumentMenu();
      return;
    }
    const mode = active.mode;
    const id = active.document.id;
    switch (button.dataset.documentAction) {
      case "rename":
        this.closeDocumentMenu();
        this.renaming = { mode, id };
        this.renderDocuments();
        return;
      case "duplicate":
        this.closeDocumentMenu();
        // The copy is selected once made: unsaved edits on the original are settled first.
        mode.controller.requestLeave(() => documents.duplicate?.(id));
        return;
      case "default":
        this.closeDocumentMenu();
        documents.setDefault?.(id);
        return;
      case "move-up":
      case "move-down": {
        const action = button.dataset.documentAction;
        this.closeDocumentMenu();
        documents.move?.(id, action === "move-up" ? -1 : 1);
        // The menu comes back on the same item, so a document can go several places in a row,
        // from the keyboard too. At an end the item is off, and focus takes the other move item
        // rather than the first one on — a repeated Enter there would start a rename.
        this.toggleDocumentMenu();
        const opposite = action === "move-up" ? "move-down" : "move-up";
        const menu = this.documentMenuEl();
        (
          menu.querySelector<HTMLElement>(`[data-document-action="${action}"]:not([disabled])`) ??
          menu.querySelector<HTMLElement>(`[data-document-action="${opposite}"]:not([disabled])`)
        )?.focus();
        return;
      }
      case "remove": {
        // Undo brings a removed document back (one step of the form's history), so the menu asks
        // in place, as every such confirmation does: the warning note, Cancel first.
        if (button.dataset.confirm === undefined) {
          const menu = this.documentMenuEl();
          menu.removeAttribute("role");
          menu.removeAttribute("aria-label");
          menu.innerHTML = this.removeNoteHtml(mode, active.document, "data-document-action=\"remove\"", "data-document-remove-keep");
          menu.querySelector<HTMLElement>("[data-document-remove-keep]")?.focus();
          return;
        }
        this.closeDocumentMenu();
        mode.controller.requestLeave(() => documents.remove?.(id));
        return;
      }
      default:
        this.closeDocumentMenu();
    }
  }

  /** The inline confirmation of a document's removal: what goes, then Cancel and Delete (the second carries `data-confirm`). */
  private removeNoteHtml(mode: BuilderMode, document: BuilderDocument, deleteAttribute: string, keepAttribute: string): string {
    const title = escapeHtml(this.words.text("shell.doc.deleteNamed", { name: document.label }));
    return `<div class="note confirm" data-tone="warning" role="group" aria-label="${title}" aria-describedby="doc-remove-why" data-remove-note>
        <p><strong>${title}</strong></p>
        <p id="doc-remove-why">${escapeHtml(this.words.text("shell.doc.deleteNote", { noun: documentNoun(mode, document, this.words) }))}</p>
        <div class="confirm-actions">
          <button type="button" class="btn small" ${keepAttribute}>${escapeHtml(this.words.text("common.cancel"))}</button>
          <button type="button" class="btn small danger" ${deleteAttribute} data-confirm>${escapeHtml(this.words.text("common.delete"))}</button>
        </div>
      </div>`;
  }

  /**
   * Focus after a rename box goes (Enter, Escape): the document's label it stood in for, or on a
   * phone, where the label is not drawn, the back title (else Menu).
   */
  private focusDocumentLabel(): void {
    const target = this.phone
      ? [this.rootNode.querySelector<HTMLElement>("[data-document-back]"), this.rootNode.querySelector<HTMLElement>("[data-menu-open]")].find(
          (candidate): candidate is HTMLElement => !!candidate && this.shownDeep(candidate)
        )
      : (this.rootNode.querySelector<HTMLElement>("button[data-document-face]") ?? undefined);
    target?.focus({ preventScroll: true });
  }

  private commitRename(value: string): void {
    const renaming = this.renaming;
    if (!renaming) {
      return;
    }
    this.renaming = undefined;
    const name = value.trim();
    const current = renaming.mode.documents?.list().find((document) => document.id === renaming.id);
    if (current && name !== "" && name !== current.label) {
      renaming.mode.documents?.rename?.(renaming.id, name);
    }
    this.renderDocuments();
  }

  /** Mirrors the mode on the page onto the `mode` attribute. */
  private reflectMode(): void {
    if (this.getAttribute("mode") !== this.activeMode.id) {
      this.reflectingMode = true;
      try {
        this.setAttribute("mode", this.activeMode.id);
      } finally {
        this.reflectingMode = false;
      }
    }
    // The workspace follows a mode change from anywhere: the dropdown, setMode, the
    // mode attribute, a host's removeMode. A designer's mode has its own workspace; the
    // form is the others', except on an overview, where the form is on the page by design.
    const designer = workspaceForMode(this.activeMode.id);
    if (designer && this.workspaceValue !== designer) {
      this.enterWorkspace(designer, { fromMode: true });
    } else if (this.activeMode.id === PRIMARY_BUILDER_MODE && isDesignerWorkspace(this.workspaceValue) && !this.returningToOverview) {
      this.enterWorkspace(this.formWorkspaceToReturn(), { fromMode: true });
    }
    this.returningToOverview = false;
    // The designer's way back to its overview, and the overview itself, follow the mode.
    this.applyWorkspace();
    // A phone draws a designer's page to its width.
    if (this.phone && this.activeMode.id !== PRIMARY_BUILDER_MODE) {
      this.fitDesignerSoon();
    }
  }

  private modeContext(mode: BuilderMode): BuilderModeContext {
    return {
      host: this,
      root: this.rootNode,
      showCanvasSurface: (surface, options) => {
        this.surfaces.set(mode, surface);
        this.surfaceOptions.set(mode, options);
        if (this.activeMode === mode) {
          this.applySurface(surface);
          // Whether the surface takes Try it moves the phone's Try it button and drawer rows.
          this.syncPhone();
        }
      },
      // A mode's own move away from what the inspector edits on another controller.
      holdForInspector: (run) => (this.activeMode === mode ? this.holdInspected(run) : (run(), true))
    };
  }

  /**
   * Switches to `mode`: its own `activate` first (the tab shows busy; a failure leaves the
   * page as it was), then, when asked, the mode's document; then the old mode's chrome comes
   * down, the panels are re-pointed and the new mode's chrome goes up. A newer switch
   * supersedes one still activating; a mode whose switch is superseded or fails is deactivated
   * again, so it is never left active off the page.
   */
  private async activateMode(mode: BuilderMode, documentId?: string): Promise<void> {
    this.endTrying();
    const token = (this.modeToken += 1);
    const previous = this.activeMode;
    const superseded = this.activating;
    this.activating = mode;
    this.takeDownSuperseded(superseded);
    // Focus on what the author pressed (a card's Open, "‹ Journeys") is put somewhere drawn once the switch lands.
    const hadFocus = this.shownFocus() !== undefined;
    const left = previous.documents ? { modeId: previous.id, documentId: previous.documents.selectedId() } : undefined;
    this.setDocumentFaceBusy(true);
    try {
      await mode.activate?.(this.modeContext(mode));
      if (documentId !== undefined && mode.documents && mode.documents.selectedId() !== documentId) {
        await mode.documents.select(documentId);
      }
    } catch (error) {
      if (token === this.modeToken) {
        this.activating = undefined;
        this.setDocumentFaceBusy(false);
        this.dispatchEvent(
          new CustomEvent<BuilderModeErrorDetail>("builder-mode-error", { detail: { mode: mode.id, error }, bubbles: true, composed: true })
        );
      }
      // Its `activate` may have run some way, or all the way before the document failed.
      this.takeDownSuperseded(mode);
      return;
    }
    if (token !== this.modeToken) {
      this.takeDownSuperseded(mode);
      return;
    }
    // Try it pressed while the mode activated ends before the panels move.
    this.endTrying();
    this.activating = undefined;
    this.setDocumentFaceBusy(false);
    previous.deactivate?.();
    this.detachModeChrome(previous);
    this.activeMode = mode;
    this.applyPanelControllers();
    this.attachModeChrome(mode);
    this.applySurface(this.surfaces.get(mode));
    if (mode.id === PRIMARY_BUILDER_MODE) {
      delete this.wrapEl.dataset.mode;
    } else {
      this.wrapEl.dataset.mode = mode.id;
    }
    this.reflectMode();
    this.renderDocuments();
    if (hadFocus) {
      this.rescueFocus(left);
    }
    this.dispatchEvent(
      new CustomEvent<BuilderModeChangeDetail>("builder-mode-change", {
        detail: { mode: mode.id, previous: previous.id },
        bubbles: true,
        composed: true
      })
    );
    this.emitDocumentChange();
  }

  /** Moves the active mode to another of its documents; the tab shows busy meanwhile. */
  private async moveToDocument(mode: BuilderMode, documentId: string): Promise<void> {
    this.endTrying();
    const token = (this.modeToken += 1);
    // A mode switch still activating is superseded by this move.
    const superseded = this.activating;
    this.activating = undefined;
    this.takeDownSuperseded(superseded);
    this.setDocumentFaceBusy(true);
    try {
      await mode.documents?.select(documentId);
    } catch (error) {
      if (token === this.modeToken) {
        this.setDocumentFaceBusy(false);
        this.dispatchEvent(
          new CustomEvent<BuilderModeErrorDetail>("builder-mode-error", { detail: { mode: mode.id, error }, bubbles: true, composed: true })
        );
      }
      return;
    }
    if (token !== this.modeToken || mode !== this.activeMode) {
      return;
    }
    // Try it pressed while the document loaded ends before the panels move.
    this.endTrying();
    this.setDocumentFaceBusy(false);
    this.applyPanelControllers();
    this.renderDocuments();
    this.emitDocumentChange();
  }

  private emitDocumentChange(): void {
    this.dispatchEvent(
      new CustomEvent<BuilderDocumentChangeDetail>("builder-document-change", {
        detail: { mode: this.activeMode.id, document: this.activeMode.documents?.selectedId() },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * Where the active mode's controls go: a `data-segmented` child (the mode's views,
   * navigation) on the bar, in the shell's pill; every other one (its worded actions) in the
   * canvas's toolbar. On a phone, whose canvas has no toolbar, every one stays in the bar's
   * group, which the menu drawer takes.
   */
  private placeModeActions(mode: BuilderMode | undefined = this.activeMode): void {
    const host = this.modeActionsEl;
    if (!host || !mode) {
      return;
    }
    const toCanvas: HTMLElement[] = [];
    for (const control of mode.barActions ?? []) {
      control.removeAttribute("slot");
      if (control instanceof HTMLButtonElement) {
        control.classList.add("bar-btn");
      }
      if (control.hasAttribute("data-segmented")) {
        control.classList.add("bar-seg");
        for (const button of control.querySelectorAll("button")) {
          button.classList.add("bar-btn");
        }
      } else if (!this.phone) {
        toCanvas.push(control);
        continue;
      }
      // Moves only what is not already home: re-inserting a focused button would blur it.
      if (control.parentElement !== host) {
        host.append(control);
      }
    }
    this.canvasEl?.setModeActions(toCanvas, this.modeLabel(mode));
  }

  /** Puts the mode's controls away again, from the bar and the canvas's toolbar. */
  private detachModeActions(mode: BuilderMode): void {
    this.canvasEl?.setModeActions([]);
    for (const control of mode.barActions ?? []) {
      control.remove();
    }
  }


  /** The shell's width on every overlay a mode put in the shadow root (they sit outside .wrap). */
  private applyShellWidth(): void {
    if (this.shellWidth <= 0) {
      return;
    }
    const value = `${this.shellWidth}px`;
    this.wrapEl?.style.setProperty("--db-shell-w", value);
    // Every overlay in the root, a mode's that is not on the page included (a PDF preview dialog
    // put up from the Form workspace); one added later inherits it from a `:host` rule
    // in the shadow root, never an inline style on the host (a framework may own the host's style).
    let rule = this.rootNode?.querySelector<HTMLStyleElement>("style[data-shell-width]");
    if (!rule && this.rootNode) {
      rule = document.createElement("style");
      rule.setAttribute("data-shell-width", "");
      this.rootNode.append(rule);
    }
    if (rule) {
      rule.textContent = `:host { --db-shell-w: ${value}; }`;
    }
    const overlays = new Set<HTMLElement>(this.activeMode?.overlays ?? []);
    for (const child of this.rootNode?.children ?? []) {
      if (child instanceof HTMLDialogElement) {
        overlays.add(child);
      }
    }
    for (const overlay of overlays) {
      overlay.style.setProperty("--db-shell-w", value);
    }
  }

  private attachModeChrome(mode: BuilderMode): void {
    this.placeModeActions(mode);
    for (const overlay of mode.overlays ?? []) {
      this.rootNode.append(overlay);
    }
    this.applyShellWidth();
    if (mode.styles) {
      const style = document.createElement("style");
      style.setAttribute("data-mode-style", mode.id);
      style.textContent = mode.styles;
      this.rootNode.append(style);
      this.modeStyleEl = style;
    }
  }

  private detachModeChrome(mode: BuilderMode): void {
    this.detachModeActions(mode);
    for (const overlay of mode.overlays ?? []) {
      overlay.remove();
    }
    this.modeStyleEl?.remove();
    this.modeStyleEl = undefined;
  }

  /** Shows a mode's surface on the canvas in the sheet's place, or the sheet again. */
  private applySurface(surface: HTMLElement | undefined): void {
    if (!this.canvasEl) {
      return;
    }
    // The mode's stylesheet goes with the surface: the canvas panel's shadow root is not
    // reached by the copy in this shell's root.
    this.canvasEl.showSurface(surface, this.activeMode.styles, this.surfaceOptions.get(this.activeMode));
    this.wrapEl.toggleAttribute("data-surface", surface !== undefined);
  }

  /** Points the panels and the bar at the mode on the page (its selected document's controller). */
  private applyPanelControllers(): void {
    const controller = this.activeMode.controller;
    /*
     * Each of the assignments below is a paint on its own — a panel repaints for its
     * controller, its icon set, its primary flag and its label in turn, and a mount would
     * cost nineteen paints across five panels where five do. Holding them here
     * makes each panel draw once, for the whole of what this says rather than each part of
     * it. Synchronous: every panel is painted by the time this returns.
     */
    // The lazy panels only once their chunk has loaded; until then there is nothing to paint.
    const panels = [this.toolbarEl, this.outlineEl, this.fieldsEl, this.canvasEl, this.propertiesEl, this.formSettingsEl, ...(this.chromePanelEl ? [this.chromePanelEl] : []), ...(this.variablesPanelEl ? [this.variablesPanelEl] : [])];
    for (const panel of panels) {
      panel.suspendPaints();
    }
    try {
      this.applyPanelControllersInner(controller);
      // Where the inspector edits, in the same paint: the mode's say, once it is on the page.
      this.listenModeInspect();
      this.syncInspection();
      // What Undo and Redo go through: the bar follows the mode's history too.
      this.listenModeHistory();
    } finally {
      for (const panel of panels) {
        panel.resumePaints();
      }
    }
    this.syncBar();
    // A move between documents brings another selection with it.
    this.syncInspector();
  }

  // --- the inspector on another controller ----------

  /**
   * What the inspector edits when the mode on the page says it is on another controller than
   * its own (`BuilderMode.inspection`): a form field placed on a journey step, edited on the form's
   * controller. `via` is what the mode's controller had selected then, put back by Keep editing
   * after a move that did not ask first. `undefined`: the inspector is on the mode's controller.
   */
  private inspected: (BuilderModeInspection & { via: string | undefined }) | undefined;
  /**
   * A move waiting on the inspected component's unsaved edits (see {@link holdInspected}): `next`
   * once Apply or Discard settles them, `stay` on Keep editing (or a refused Apply).
   */
  private inspectHold: { held: BuilderModeInspection; next: () => void; stay: () => void } | undefined;
  /**
   * Set by Keep editing after a move that did not ask, when what the mode's controller had
   * selected is gone (taken away by the outline, an agent): the inspector stays on the draft
   * until it is applied or discarded, rather than asking again at once.
   */
  private inspectPinned = false;
  /** The mode whose `subscribeInspection` is heard, and the unsubscribe. */
  private inspectSubscription: { mode: BuilderMode; off: () => void } | undefined;
  /** The controller the inspected component lives on, heard for the prompt's answer. */
  private inspectListened: { controller: BuilderController; off: () => void } | undefined;
  /** The leave guard on the mode's controller while the inspector is on another (see {@link syncInspectGuard}). */
  private inspectGuard: { controller: BuilderController; off: () => void } | undefined;

  /** Hears the mode on the page say its inspection moved; the previous mode is no longer heard. */
  private listenModeInspect(): void {
    const mode = this.activeMode;
    if (this.inspectSubscription?.mode === mode) {
      return;
    }
    this.inspectSubscription?.off();
    this.inspectSubscription = undefined;
    const off = mode.subscribeInspection?.(() => {
      if (this.activeMode === mode) {
        this.syncInspection();
      }
    });
    if (off) {
      this.inspectSubscription = { mode, off };
    }
  }

  /**
   * Points the inspector where the mode on the page says, in one paint: on another
   * controller, with the component selected there and the form's tabs; else back on the mode's
   * own. The mode's buttons go to the inspector's about card, and the one standing in for
   * Delete to the canvas's selection bar, each behind {@link holdInspected}. A move away from a
   * component holding unsaved edits that did not ask first (the outline, a host, an agent) is
   * held here: the inspector stays on it with the prompt up. A shell whose modes say nothing of
   * this (the form, the PDF designer) is left exactly as it was.
   */
  private syncInspection(): void {
    if (!this.propertiesEl || !this.canvasEl) {
      return;
    }
    const mode = this.activeMode;
    const props = this.propertiesEl;
    const canvas = this.canvasEl as DatumBuilderCanvasElement;
    if (!mode.inspection && !mode.inspectorActions && !this.inspected && props.modeActions.length === 0 && !canvas.deleteAction && !canvas.selectionGuard) {
      return;
    }
    // While a move waits on the prompt, it takes the latest say once the prompt is answered.
    if (this.inspectHold) {
      return;
    }
    const own = mode.controller;
    const said = mode.inspection?.();
    const routed = said && said.controller !== own ? said : undefined;
    const current = this.inspected;
    const moved = !current || !routed || current.controller !== routed.controller || current.componentId !== routed.componentId;
    if (current && current.controller.hasPendingChanges(current.componentId) && (moved || this.inspectPinned)) {
      if (this.inspectPinned) {
        return;
      }
      // Moved by a path that did not ask: asked now, the inspector still on the draft.
      this.holdInspected(
        () => this.syncInspection(),
        () => {
          const back = current.via;
          if (own.selectedComponentId() === back) {
            // The selection is where it was, yet the mode no longer routes the inspector to the
            // draft (a journey's Step view put away): kept in view until settled, never asked again in a loop.
            const still = mode.inspection?.();
            if (still?.controller !== current.controller || still.componentId !== current.componentId) {
              this.inspectPinned = true;
            }
            return;
          }
          if (back !== undefined && own.editedNode(back) !== undefined) {
            own.select(back);
          } else {
            this.inspectPinned = true;
          }
        }
      );
      return;
    }
    this.inspectPinned = false;
    const wasRouted = current !== undefined;
    props.suspendPaints();
    try {
      if (routed) {
        // Selected where it is edited, directly: the guard has had its say before this.
        if (routed.controller.selectedComponentId() !== routed.componentId) {
          routed.controller.select(routed.componentId);
        }
        if (props.controller !== routed.controller) {
          props.controller = routed.controller;
        }
        // Every time: the panels' re-pointing sets the mode's own (each setter paints only on a change).
        this.applyInspectorSettings(this.modeOwning(routed.controller));
        this.inspected = { controller: routed.controller, componentId: routed.componentId, via: own.selectedComponentId() };
      } else {
        if (wasRouted) {
          if (props.controller !== own) {
            props.controller = own;
          }
          this.applyInspectorSettings(mode);
        }
        this.inspected = undefined;
      }
      const actions = (mode.inspectorActions?.() ?? []).map((action) => ({
        ...action,
        run: () => {
          this.holdInspected(() => action.run());
        }
      }));
      props.modeActions = actions;
      const standIn = actions.find((action) => action.deleteLabel !== undefined);
      const selected = own.selectedComponentId();
      canvas.deleteAction = standIn && selected !== undefined ? { componentId: selected, label: standIn.deleteLabel!, run: standIn.run } : undefined;
    } finally {
      props.resumePaints();
    }
    canvas.selectionGuard = mode.inspection ? (run) => this.holdInspected(run) : undefined;
    this.listenInspected(this.inspected?.controller);
    this.syncInspectGuard(this.inspected ? own : undefined);
  }

  /** The mode whose controller `controller` is (the form's for the builder's own), for the inspector's settings. */
  private modeOwning(controller: BuilderController): BuilderMode {
    return [...this.modeMap.values()].find((mode) => mode.controller === controller) ?? this.modeMap.get(PRIMARY_BUILDER_MODE)!;
  }

  /** The inspector's settings for a tree of `mode`'s, as {@link applyPanelControllersInner} sets them for the mode on the page. */
  private applyInspectorSettings(mode: BuilderMode): void {
    this.propertiesEl.primary = mode.id === PRIMARY_BUILDER_MODE;
    const rules = mode.inspector?.rules;
    this.propertiesEl.showRulesTab = rules !== false && this.featureEnabled("logic");
    this.propertiesEl.ruleSource = typeof rules === "object" ? rules : undefined;
  }

  /**
   * Runs `run` once the component the inspector edits on another controller holds no unsaved
   * edits: at once when it holds none (or the inspector is on the mode's own). Else the
   * inspector puts up its unsaved-edits prompt for it (asked on that controller as a move away
   * from it, so the panel showing it draws it); Apply or Discard runs `run`, Keep editing runs
   * `stay`. A newer move replaces one still waiting: the latest is the one that counts. Answers
   * whether `run` ran now.
   */
  private holdInspected(run: () => void, stay: () => void = () => undefined): boolean {
    const held = this.inspected;
    if (!held || !held.controller.hasPendingChanges(held.componentId)) {
      run();
      return true;
    }
    if (held.controller.selectedComponentId() !== held.componentId) {
      held.controller.select(held.componentId);
    }
    this.inspectHold = { held: { controller: held.controller, componentId: held.componentId }, next: run, stay };
    // The controller's own prompt: a move away from its selection, which holds for its draft.
    held.controller.requestSelect(undefined);
    return false;
  }

  /** Hears the controller the inspected component is on: the prompt's answer goes on, or stays. */
  private listenInspected(controller: BuilderController | undefined): void {
    if (this.inspectListened?.controller === controller) {
      return;
    }
    this.inspectListened?.off();
    this.inspectListened = undefined;
    if (!controller) {
      return;
    }
    const offSelection = controller.on("selection", () => {
      const hold = this.inspectHold;
      // Apply or Discard settled the draft and let the move away from it through: the move now.
      if (hold && hold.held.controller === controller && controller.selectedComponentId() !== hold.held.componentId) {
        this.inspectHold = undefined;
        hold.next();
        this.syncInspection();
      }
    });
    const offChange = controller.on("change", (event) => {
      const hold = this.inspectHold;
      if (hold && hold.held.controller === controller) {
        // Keep editing, or an Apply refused: no prompt, the draft still there, the selection kept.
        if (!controller.unsavedChangesPrompt() && controller.selectedComponentId() === hold.held.componentId && controller.hasPendingChanges(hold.held.componentId)) {
          this.inspectHold = undefined;
          hold.stay();
        }
        return;
      }
      // A draft kept in view after its selection went (Keep editing) follows the mode once settled.
      if (this.inspectPinned && !event.live && this.inspected && !controller.hasPendingChanges(this.inspected.componentId)) {
        this.syncInspection();
      }
    });
    this.inspectListened = {
      controller,
      off: () => {
        offSelection();
        offChange();
      }
    };
  }

  /**
   * While the inspector edits on another controller, the mode's controller holds a leave guard
   * for that component's unsaved edits: every departure the shell makes through
   * `requestLeave` — leaving the workspace or the document, Try it, New and Open, a click on
   * empty canvas — and a mode's own, wait for them. The prompt is the inspector's: the guard's
   * hold is answered through {@link holdInspected}.
   */
  private syncInspectGuard(controller: BuilderController | undefined): void {
    if (this.inspectGuard?.controller === controller) {
      return;
    }
    this.inspectGuard?.off();
    this.inspectGuard = undefined;
    if (!controller) {
      return;
    }
    const pendingNow = (): BuilderModeInspection | undefined => {
      const inspected = this.inspected;
      return inspected && inspected.controller.hasPendingChanges(inspected.componentId) ? inspected : undefined;
    };
    const guard: LeaveGuard = {
      pending: () => pendingNow() !== undefined,
      subject: () => ({ id: INSPECTED_LEAVE_GUARD, label: this.inspected?.componentId ?? "", blocked: false }),
      save: () => {
        const inspected = pendingNow();
        return !inspected || inspected.controller.commitDraft(inspected.componentId);
      },
      discard: () => {
        const inspected = pendingNow();
        inspected?.controller.discardDraft(inspected.componentId);
      }
    };
    const offGuard = controller.pushLeaveGuard(guard);
    const offChange = controller.on("change", () => {
      // The guard's hold, asked as the inspector's own prompt; its answer answers the hold.
      if (controller.unsavedChangesPrompt()?.external?.id === INSPECTED_LEAVE_GUARD && this.inspectHold === undefined) {
        this.holdInspected(
          () => controller.answerUnsavedChangesPrompt("save"),
          () => controller.answerUnsavedChangesPrompt("stay")
        );
      }
    });
    this.inspectGuard = {
      controller,
      off: () => {
        offGuard();
        offChange();
      }
    };
  }

  private applyPanelControllersInner(controller: BuilderController): void {
    // Whether the form-level controls (the Localization section, the locale switcher) apply
    // is settled before the panels paint for the controller.
    const primary = this.activeMode.id === PRIMARY_BUILDER_MODE;
    this.canvasEl.primary = primary;
    this.propertiesEl.primary = primary;
    this.formSettingsEl.primary = primary;
    if (this.chromePanelEl) {
      this.chromePanelEl.primary = primary;
    }
    // The Form fields panel is the mode's (a journey's Step view): pointed at it, or at nothing on a mode with none.
    this.watchFormFields();
    // The Journey panel's findings card is the mode's too.
    this.watchFindings();
    // The Variables panel lists the Rules tab's paths on the form, and the placeholders a PDF text reads on any other mode.
    if (this.variablesPanelEl) {
      this.variablesPanelEl.primary = primary;
    }
    if (this.testsPanelEl) {
      this.testsPanelEl.primary = primary;
    }
    // The header and footer are the form's: another mode's document has none, so
    // its tab has no Header & footer item, and a shell left on that panel moves to Form.
    const chromeItem = this.rootNode.querySelector<HTMLElement>("[data-chrome-panel-item]");
    if (chromeItem) {
      // Also away when the `features` list or `hidden-panels` leave the panel off.
      chromeItem.hidden = !primary || this.panelOff("chrome");
    }
    if (!primary && this.activePanel === "chrome") {
      this.setPanel("form");
    }
    // Whether the Rules tab is offered is the mode's to say: a PDF layout's nodes carry none the
    // PDF reads; a journey's offer their own, stored in their configuration.
    const rules = this.activeMode.inspector?.rules;
    const ruleSource = typeof rules === "object" ? rules : undefined;
    // Rules are Logic's: without the `logic` feature there is no Rules tab on any mode.
    this.propertiesEl.showRulesTab = rules !== false && this.featureEnabled("logic");
    this.formSettingsEl.showRulesTab = rules !== false && this.featureEnabled("logic");
    this.propertiesEl.ruleSource = ruleSource;
    this.formSettingsEl.ruleSource = ruleSource;
    if (this.variablesPanelEl) {
      // What the Variables panel lists is the mode's to say too; unset, it follows `primary`.
      this.variablesPanelEl.modeSyntax = this.activeMode.variables;
      // In the Journeys workspace the journey's own tree (pages, its own nodes) feeds the condition paths.
      this.variablesPanelEl.journeyController = this.activeMode.id === DESIGNER_WORKSPACES.journeys ? controller : undefined;
    }
    // Other modes' rows on the form's settings, drawn on the form's own tab.
    this.formSettingsEl.modeSettings = this.modeSettingsGroups();
    // What the Form panel calls what it edits: the form, or the mode's own word for a document.
    this.formSettingsEl.settingsLabel =
      this.activeMode.inspector?.settingsLabel ?? (primary ? this.workspaceLabel("form") : this.modeLabel(this.activeMode));
    this.applyPanelIcons();
    if (this.pointedController !== controller) {
      this.pointedController = controller;
      this.bindBar(controller);
      this.toolbarEl.controller = controller;
      // The canvas before the outline: the outline reads which components the canvas is
      // hiding, so it must paint after the canvas has.
      this.canvasEl.controller = controller;
      this.outlineEl.controller = controller;
      this.fieldsEl.controller = controller;
      this.propertiesEl.controller = controller;
      this.formSettingsEl.controller = controller;
      if (this.chromePanelEl) {
        this.chromePanelEl.controller = controller;
      }
      this.renderAddRail();
      if (this.logicEl) {
        this.logicEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      }
      if (this.dataEl) {
        this.dataEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      }
      if (this.languagesEl) {
        this.languagesEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      }
      if (this.printEl) {
        this.printEl.controller = this.modeMap.get(PRIMARY_BUILDER_MODE)!.controller;
      }
    }
  }

  /** Whether the strip is offering the Header & footer item: not on another mode's tab. */
  private chromeItemHidden(): boolean {
    return Boolean(this.rootNode.querySelector<HTMLElement>("[data-chrome-panel-item]")?.hidden ?? true);
  }

  private isContained(): boolean {
    return this.layout === "contained";
  }

  /** Mirrors {@link layout} onto the wrap, which the stylesheet keys its contained rules on. */
  private applyLayout(): void {
    if (this.isContained()) {
      this.wrapEl.dataset.layout = "contained";
    } else {
      delete this.wrapEl.dataset.layout;
    }
  }

  /**
   * Inline-styles `--db-*` vars set here beat each panel's own internal `:host {}` defaults
   * (inline style outranks a shadow root's own stylesheet), and survive that panel's
   * `render()` calls since those only touch `this.root.innerHTML`, not `this.style`.
   */
  private applyTheme(): void {
    const targets = this.themeTargets();
    for (const name of this.appliedThemeVars) {
      for (const el of targets) {
        el.style.removeProperty(name);
      }
    }
    this.appliedThemeVars = [];

    const vars = this.themeVars() ?? {};
    this.appliedThemeVars = Object.keys(vars);
    for (const [name, value] of Object.entries(vars)) {
      for (const el of targets) {
        el.style.setProperty(name, value);
      }
    }
    // The form on the canvas follows the builder's scheme when the binding that draws it has a dark look.
    this.ctrl.setPreviewScheme(this.scheme);
    // The canvas judges the sheet against the builder's scheme, which these vars just changed.
    this.canvasEl?.syncSheetScheme?.();
  }

  /**
   * Every host that declares the token defaults on itself (`builderTokens()`), which an inherited
   * value cannot beat: the theme has to be set on each one, the strip panels and the lazy
   * surfaces included The lazy panels' elements whether loaded or not
   *: inline style survives the upgrade. A surface made after the theme was applied
   * gets it from {@link paintThemeVars} where it is created.
   */
  private themeTargets(): HTMLElement[] {
    const optional = [
      this.chromePanelHost,
      this.variablesPanelHost,
      this.testsPanelHost,
      this.logicEl,
      this.dataEl,
      this.languagesEl,
      this.printEl,
      this.overviewEl,
      this.paletteEl
    ];
    return [
      this,
      this.toolbarEl,
      this.outlineEl,
      this.fieldsEl,
      this.canvasEl,
      this.propertiesEl,
      this.formSettingsEl,
      ...optional.filter((el): el is NonNullable<typeof el> => el !== undefined)
    ];
  }

  /** The theme's vars on a themed host created after the theme was applied (a lazy surface, the palette, the catalog). */
  private paintThemeVars(el: HTMLElement): void {
    const vars = this.themeVars();
    if (!vars) {
      return;
    }
    for (const [name, value] of Object.entries(vars)) {
      el.style.setProperty(name, value);
    }
  }

  private wireController(): void {
    this.unsub.push(
      this.ctrl.on("change", (event) => {
        this.dispatchEvent(
          new CustomEvent<DatumBuilderChangeDetail>("builder-change", {
            detail: {
              root: event.root,
              selectedComponentId: event.selectedComponentId,
              reason: event.reason,
              // Copies: what the controller announced is the step's own, and the shell and the seed route read it again after the host has heard.
              ...(event.renamed
                ? {
                    renamed: {
                      ...event.renamed,
                      ...(event.renamed.rules ? { rules: [...event.renamed.rules] } : {}),
                      ...(event.renamed.unparsed ? { unparsed: event.renamed.unparsed.map((note) => ({ ...note })) } : {}),
                      ...(event.renamed.dataPath ? { dataPath: { ...event.renamed.dataPath } } : {})
                    }
                  }
                : {}),
              ...(event.renameStepped ? { renameStepped: { ...event.renameStepped } } : {}),
              ...(event.dataMoved ? { dataMoved: event.dataMoved.map((move) => ({ from: move.from, to: move.to })) } : {}),
              ...(event.historyStep ? { historyStep: event.historyStep } : {})
            }
          })
        );
        // A rename's follow in the scenarios waits for the chunk; one that lands after another form came is dropped.
        if (event.reason === "init") {
          this.testsGeneration += 1;
          this.droppedFollows = [];
        }
        const historyStep = event.historyStep;
        // Logic's Pinned-by line follows the form and its tests: a change to the tree or to the block
        // moves the key, and the line is read again when Logic is the workspace on show.
        if (event.reason === "init" || event.reason === "add" || event.reason === "move" || event.reason === "remove" || event.reason === "edit") {
          if (!event.live) {
            this.testsPinsStamp += 1;
            this.feedTestsPins();
          }
        }
        // The data-key problems the Data tab counts move with the form.
        if (event.reason !== "select" && event.reason !== "preview" && !event.live) {
          this.applyWorkspaceCounts();
        }
        // A language renamed in the Languages workspace (or put back by an undo) is followed in the scenarios that set it.
        if (event.reason === "init") {
          this.localeTargets = new Map();
        } else if (event.reason === "edit" && !event.live) {
          this.followLocaleRenames();
        }
        // Modes naming the form's components in documents of their own follow a new id there
        // (a PDF layout's condition), right after the host hears of the form's change.
        const renamed = event.renamed;
        if (renamed && historyStep === undefined) {
          for (const mode of [...this.modeMap.values()]) {
            mode.formRenamed?.(renamed);
          }
          this.followRenameInTests(renamed, event.root);
        }
        // An edit that moved where answers are stored (a data key) is followed the same way by
        // whatever reads answers by value path: each mode at once, the scenarios once their chunk is in.
        // Both join the edit's own step, so one Undo takes the move and everything it rewrote back. An
        // Undo or a Redo of the step is not followed again: its entry holds the rewrites, and a move
        // map applied twice would undo a swap. Only the scenarios' follow the step lost to its Undo
        // runs again on its Redo.
        const dataMoved = event.dataMoved;
        if (dataMoved && dataMoved.length > 0 && historyStep === undefined) {
          for (const mode of [...this.modeMap.values()]) {
            mode.formDataMoved?.(dataMoved);
          }
          this.followDataMovedInTests(dataMoved, renamed);
        }
        if (historyStep === "redo") {
          this.followRedone(event);
        }
        // A dropped follow is only for its step's Redo: once nothing can be redone, it has no step to join.
        if (this.droppedFollows.length > 0 && !this.ctrl.canRedo()) {
          this.droppedFollows = [];
        }
      })
    );
    this.unsub.push(
      this.ctrl.on("mutation", (mutation: BuilderMutationEvent) => {
        this.dispatchEvent(
          new CustomEvent("builder-mutation", { detail: mutation, bubbles: true, composed: true })
        );
      })
    );
  }

  private emitChange(reason: BuilderChangeReason): void {
    this.dispatchEvent(
      new CustomEvent<DatumBuilderChangeDetail>("builder-change", {
        detail: {
          root: this.ctrl.snapshot(),
          selectedComponentId: this.ctrl.selectedComponentId(),
          reason
        }
      })
    );
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    const delta = event.clientX - drag.startX;
    const next =
      drag.kind === "side"
        ? Math.max(SIDE_MIN, Math.min(drag.startW + delta, SIDE_MAX))
        : Math.max(PROPS_MIN, Math.min(drag.startW - delta, PROPS_MAX));
    this.wrapEl.style.setProperty(drag.kind === "side" ? "--db-side-w" : "--db-props-w", `${Math.round(next)}px`);
  };

  private readonly onMouseUp = (): void => {
    if (this.drag) {
      this.wrapEl.toggleAttribute("data-resizing", false);
      this.drag = undefined;
      this.savePanels();
    }
    this.drag = undefined;
  };
}

export function defineDatumBuilderElement(): void {
  defineBuilderPanels();
  defineBuilderOutline();
  defineBuilderFormFields();
  // The Header & footer and Variables panels are defined when their chunk arrives;
  // a page using either on its own calls defineBuilderChromePanel / defineBuilderVariablesPanel.
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_TAG_NAME)) {
    customElements.define(DATUM_BUILDER_TAG_NAME, DatumBuilderElement);
  }
}
