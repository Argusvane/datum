/**
 * The PDF designer as a mode of `<datum-builder>`: the form's PDF
 * layouts, one tab each on the builder's bar, edited with the builder's own palette, canvas
 * and inspector — each layout over a controller of its own, so undo, drafts and selection
 * survive a move between tabs. A custom layout is designed on the page sheet; a populated-form
 * layout (an existing PDF filled from the answers) shows the PDF's pages on the canvas, its
 * fields and the areas drawn on them as the layout's tree: a box selected on a page is edited
 * in the inspector, landed by Save, undone like any other edit, and the layout in the catalog
 * follows every commit. The bar's `+` adds a layout (a custom one, or a populated form over a
 * PDF loaded or picked); the active tab's menu renames, copies, moves, defaults and removes.
 *
 * A form may have no layout at all: nothing is derived into the definition for the
 * author, the last layout can be removed, and the canvas shows an empty state in the sheet's
 * place. A host asked for such a form's PDF prints the layout the engine derives from the form,
 * which is what Preview shows here too.
 *
 * A layout may carry a condition: a download that names no layout prints the first,
 * in list order, whose `when` holds on the answers, else the default. It is edited on the
 * layout root's Rules tab ("Print this layout when", `layout-conditions.ts`), whose opening
 * line says where the layout stands in the order; Move up / Move down set the order; the
 * dropdown marks a conditional layout with a Conditional badge; the Form panel on the form's
 * own tab says the order in words (read-only: the default is set from the documents menu);
 * a form component renamed on the Form tab is followed into every layout's condition, an
 * unsaved one on the Rules tab included. Findings are advisory notes and never hold a Save.
 *
 * The mode holds the catalog (`PdfModeModel`) and reports every change through its options'
 * callbacks; an element wraps it in DOM events. The PDF executor — the kernel that renders
 * previews and inspects PDFs — is `support`, given up front or as a loader run on first use;
 * until it is there, a populated form waits for its fields.
 *
 * This file is the thin shell on the page: the catalog, the bar, the conditions and the words.
 * The designers over a layout, the page viewer, the Preview dialog and the Add popover are a
 * chunk of their own (`pdf-designer-chunk.ts`, loaded by `pdf-designer-loader.ts`) that the first
 * layout to open, Preview PDF or Add asks for, as the Journeys designer's is. Whatever must answer
 * at once — history, a language removed, Save, the catalog's own edits — stays here and never waits for it.
 */
import type { DataSourceSet, TranslationCatalog } from "../../core/schema/contracts.js";
import {
  copyTranslations,
  listTranslations,
  moveTranslations,
  pruneTranslations,
  readTranslation,
  writeTranslationEntry,
  type FormTranslations,
  type TextAddress,
  type TextSources,
  type TranslationEntry,
  type TranslationPrefix
} from "../../core/localization/translations.js";
import { carryChange, carryMembership, sameData, type OutsideDocument } from "../../core/localization/locale-documents.js";
import type { BuilderCommand } from "../history/command-history.js";
import type { RenamedTextId } from "../controller/translation-rules.js";
import type { ValuePathMove, ValuePathMoves } from "../formula/rename.js";
import { builderPlural, builderText, formatListText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { formTranslationsOf, layoutTextChanges, pdfLayoutTexts, pdfOutsideTexts, recordFormStep, rewriteFormTranslations, setPdfLayoutDefaults } from "./pdf-layout-texts.js";
import { readPdfLayoutCondition, resolvePdfPageSetup, type PdfConfiguration, type PdfLayoutDocument, type PdfTemplateLayout, type PdfTemplateSource } from "../../core/schema/pdf-layout.js";
import type { ComponentNode, LocalizationConfiguration } from "../../core/schema/types.js";
import type { DataSourceResolver } from "../../render/core/component-options.js";
import type { RenderableRuntime } from "../../render/core/runtime-render-bridge.js";
import { escapeHtml } from "../../render/core/escape-html.js";
import type { PdfTemplateFieldInfo, PdfTemplateInfo } from "../../render/pdf/pdf-abi.js";
import type { PdfThemeOption } from "../../render/pdf/pdf-components.js";
import type { PdfPageRasterizer } from "../../render/pdf/pdf-pages.js";
import type { PdfBindingSuggestion, PdfThemeDefinition, PdfThemeSource } from "../../render/pdf/pdf-theme.js";
import {
  BASE64_TEMPLATE_RESOLVER,
  buildPdfInspectRequest,
  type PdfFontProvider,
  type PdfImageResolver,
  type PdfRenderProvider,
  type PdfProfileOption,
  type PdfTemplateOption,
  type PdfTemplateResolver
} from "../../render/pdf/pdf-provider.js";
import { renderFormPdf, type RenderFormPdfResult } from "../../render/pdf/pdf-service.js";
import { BuilderController, type BuilderChangeReason, type BuilderControllerOptions, type BuilderNote, type InsertComponentsResult, type TranslatableText } from "../controller/builder-controller.js";
import type {
  BuilderDocument,
  BuilderDocuments,
  BuilderFormSettingReadOnlyRow,
  BuilderFormSettings,
  BuilderMode,
  BuilderModeAddOptions,
  BuilderModeContext,
  BuilderModeHistory,
  BuilderModeRules
} from "../web-component/builder-modes.js";
import { appliedStep, formStepsOnPage } from "../history/form-steps-on-page.js";
import {
  addPdfLayout,
  duplicatePdfLayout,
  movePdfLayout,
  newGeneratedPdfLayout,
  pdfLayoutIdFromName,
  pdfLayoutLabel,
  pdfLayoutsOf,
  removePdfLayout,
  replacePdfLayout,
  setDefaultPdfLayout,
  uniquePdfLayoutId,
  type DuplicatePdfLayoutOptions
} from "./layout-catalog.js";
import {
  followRenameInLayoutTree,
  pdfConditionFieldOptions,
  pdfConditionFormulaFields,
  pdfLayoutConditionFindings,
  pdfLayoutOrderInWords,
  pdfLayoutRuleDescriptors,
  pdfLayoutRulesNote,
  renamePdfLayoutConditions,
  withPdfLayoutCondition,
  type PdfLayoutConditionContext
} from "./layout-conditions.js";
import type { FormulaFunctionsSource } from "../web-component/builder-panels.js";
import type { PdfDesigner } from "./pdf-designer.js";
import { loadPdfDesigner, type PdfDesignerModule } from "./pdf-designer-loader.js";
import type { AddPopover, PreviewDialog } from "./pdf-designer-panels.js";
import { PDF_DESIGNER_PANEL_STYLES } from "./pdf-panel-styles.js";
import { MODAL_INSET, followModalBox } from "../web-component/modal-place.js";
import { embeddedTemplateProblem, sameTemplate, templateProvenance, type DefinitionBudget } from "./pdf-template-source.js";
import { PdfModeModel, type PdfModeSeed } from "./pdf-mode-model.js";
import type { PdfTemplateDesigner } from "./pdf-template-designer.js";
import type { TemplateFormFieldsPlan } from "./template-mode.js";
import type { TemplatePageViewer } from "./template-pages.js";

export const PDF_BUILDER_MODE = "pdf";

/** The PDF executor: what renders bytes, fills templates and inspects PDFs. */
export interface PdfBuilderModeSupport {
  provider: PdfRenderProvider;
  fonts?: PdfFontProvider | undefined;
  images?: PdfImageResolver | undefined;
  /** The host's default PDF theme, for a layout that names none. */
  theme?: PdfThemeDefinition | undefined;
  /**
   * The binding the form is drawn by and the PDF theme it suggests. A layout that names no theme,
   * under a host that names none either, previews under the suggestion.
   */
  binding?: PdfBindingSuggestion | undefined;
  /** Where a layout's `theme` id is looked up: the host's theme registry, or a lookup. */
  themes?: PdfThemeSource | undefined;
  /** Draws a template's pages for the area editor. Absent: blank sheets of the right size. */
  pages?: PdfPageRasterizer | undefined;
}

export type PdfBuilderModeSupportSource = PdfBuilderModeSupport | (() => Promise<PdfBuilderModeSupport>);

/** A change to the definition's PDF layouts. */
export interface PdfBuilderModeChangeDetail {
  /** The layout the change concerns: the one designed, or the one added, renamed, copied, removed or given a mapping. */
  layout: PdfLayoutDocument;
  /** The definition's `pdf` block as it stands. */
  pdf: PdfConfiguration;
  /**
   * A builder reason for an edit on the canvas or in the inspector; `"layouts"` for the list —
   * and for a form rename followed into a layout's condition, one change per layout
   * rewritten; `"template"` for a template edit landed.
   */
  reason: BuilderChangeReason | "layouts" | "template";
  /** The layout the page moved to with this change, when it moved. */
  select?: string | undefined;
}

/** The page moved to another of the form's layouts. Nothing in the definition changed. */
export interface PdfBuilderModeSelectDetail {
  layoutId: string;
  layout: PdfLayoutDocument;
}

/** A layout is up: its designer built over it, its pages on the canvas for a populated form. */
export interface PdfBuilderModeReadyDetail {
  layout: PdfLayoutDocument;
}

export interface PdfBuilderModeOptions {
  /** The executor, or a loader for it (the kernel module, fetched on first use). Absent: `support` may be assigned later. */
  support?: PdfBuilderModeSupportSource | undefined;
  /** The form the layouts print — read whenever the mode activates, so the designer follows the form's edits. */
  formRoot(): ComponentNode;
  /**
   * The form's own controller, for a populated form's "Create form fields": the
   * fields the template needs go into the form there, as one undoable insert on the Form tab.
   * Absent, the button is not offered.
   */
  form?(): BuilderController | undefined;
  /**
   * The host's registered PDF themes, for the document's "PDF theme" select — read when a
   * layout's designer is built (a list that changes afterwards shows on the next `reseed`).
   * Kept apart from `support`, so listing themes never loads the executor. Absent: a free id.
   */
  pdfThemes?(): readonly PdfThemeOption[] | undefined;
  /** Sample answers the previews show; absent, fields preview empty. */
  values?(): Record<string, unknown>;
  locale?(): string | undefined;
  /** The host's translation catalog (host data; an entry there wins over the definition's own). */
  translations?(): TranslationCatalog | undefined;
  /**
   * The definition's own translations (`FormDefinition.translations`), read live. The
   * layouts' texts are strings in the form's default language; their translations are this map's
   * `pdf` kind, which the Languages workspace edits through the form's controller. The mode reads
   * it to word the canvas and the layout names, and rewrites it only to prune or move what a
   * deleted or renamed layout, node or mapping leaves behind (through `form()`'s
   * `rewriteTranslations`). Absent: read from `form()`, else none.
   */
  formTranslations?(): FormTranslations | undefined;
  /**
   * The host's builder texts per locale (`BuilderTextCatalog`), read live: the bar's words, the
   * panels', the findings' and the layouts' rows in Languages come from it in the builder's
   * `locale`. Absent, English.
   */
  textCatalog?(): BuilderTextCatalog | undefined;
  /**
   * The form's `FormDefinition.localization` — its supported locales. A layout's own text (its
   * name, the document title, headings, static text) is a string in the default language, and
   * the Languages workspace holds its translations; the mode declares the locales on
   * its controllers all the same, for the inspector's coverage line. The list itself is edited on
   * the Form side only. Read whenever the mode activates, so a locale the form gains is offered
   * on the next visit. Absent: single-language.
   */
  localization?(): LocalizationConfiguration | undefined;
  dataSources?(): DataSourceSet | undefined;
  dataSourceResolver?: DataSourceResolver | undefined;
  /** A runtime over the form and the sample answers, for previews and test fills: the host's live one, or one it builds. */
  runtime(): RenderableRuntime;
  /**
   * A runtime over the form and the answers tried in Try it laid over the sample ones,
   * for the bar's Preview PDF. Absent or returning undefined: `runtime` is used. The shell's
   * wrapper returns one only when Try it holds an answer, so a host's own runtime keeps its
   * precedence otherwise.
   */
  triedRuntime?(): RenderableRuntime | undefined;
  /**
   * How many answers `triedRuntime` carries that were typed in Try it: its runtime also holds
   * the host's sample values, which are not the author's. Absent: the runtime's dirty keys.
   */
  triedCount?(): number;
  /**
   * Empties the answers tried in Try it, for the preview dialog's Clear answers. Absent: the
   * dialog offers no such button.
   */
  clearTried?(): void;
  /** The host's template resolver: a populated form's PDF from the source it names, the PDFs the host offers authors, and the ICC profiles it offers as output conditions. */
  templates?(): PdfTemplateResolver | undefined;
  /**
   * What the whole definition would weigh with `pdf` as its block, and the most a load accepts:
   * UTF-8 bytes of its JSON, as the load path (`src`, Open) counts them. An uploaded template is
   * stored inside the definition as base64, so the mode asks before it embeds one and refuses
   * the layout that would make the form unloadable. Absent: nothing is refused, as for a host
   * that does not load definitions back through a limit. A template from the host's own store
   * keeps its bytes out of the definition and is never asked about.
   */
  definitionBytes?(pdf: PdfConfiguration): DefinitionBudget | undefined;
  /** The form's title, for a derived layout's heading. Absent: the root's `configuration.title`. */
  title?(): string | undefined;
  /** The definition's `pdf` block to start from; none gets the layout derived from the form. */
  pdf?: PdfConfiguration | undefined;
  /** Which layout to put on the page first; absent, the default. */
  layoutId?: string | undefined;
  onChange?(detail: PdfBuilderModeChangeDetail): void;
  onSelect?(detail: PdfBuilderModeSelectDetail): void;
  onReady?(detail: PdfBuilderModeReadyDetail): void;
  /** A declared layout was unusable and left out, the executor could not load, an edit could not be kept. */
  onError?(message: string, cause?: unknown): void;
}

export interface NewPdfLayoutOptions {
  name: string;
  /** The layout the engine derives from the form, a blank page, or a copy of the layout on the page. */
  from: "form" | "blank" | "copy";
  /** Put the new layout on the page. Default `true`. */
  select?: boolean | undefined;
}

export interface PdfBuilderMode extends BuilderMode {
  /**
   * The layouts' block as a document the form's history rewrites when a language is made the
   * default (the layouts' default strings change with the map, in one undo step) and when the
   * Languages workspace applies (`BuilderController.setOutsideDocuments`). It lists every text
   * with its default and writes defaults; the translations are the definition's map, never the
   * layouts'.
   */
  localeDocument(): OutsideDocument;
  /**
   * Every layout's words for the Languages workspace: names, document titles, headings and
   * static text, attachment descriptions, signature reasons, template fill texts — each the
   * default string and the `pdf › <layoutId> › …` address its translations live at.
   */
  languageTexts(words?: BuilderTextOptions): TranslatableText[];
  /** The executor. Assigning one (or a loader) enables the controls that need it. */
  support: PdfBuilderModeSupportSource | undefined;
  /** The definition's `pdf` block as edited. Assigning replaces the layouts. */
  pdfConfiguration: PdfConfiguration;
  /** Every layout's path sources follow the form's moves of data (`BuilderChangeEvent.dataMoved`), in the edit's step of the history. */
  formDataMoved(moves: readonly ValuePathMove[]): void;
  /** Starts over on another form's layouts (the form itself changed underneath the mode). */
  reseed(seed: PdfModeSeed): void;
  readonly layouts: PdfLayoutDocument[];
  /** The layout on the page; assigning puts another one there. */
  layoutId: string | undefined;
  /** The layout on the page as it stands — as designed so far, unsaved inspector drafts aside. */
  readonly pdfLayout: PdfLayoutDocument | undefined;
  /**
   * The declared layouts the last seed — the first one included — left out as unusable, each as
   * "id: problems". The mode reports them through `onError` when it seeds; a definition read
   * back from here no longer has them, so a host's saved baseline should still count them.
   */
  readonly unusableLayouts: readonly string[];
  /** Whether the layout on the page is up: its designer built over it. */
  readonly ready: boolean;
  /** The designer over a custom layout on the page; `undefined` over a populated form. */
  readonly designer: PdfDesigner | undefined;
  /** The designer over a populated form on the page; `undefined` over a custom layout. */
  readonly templateDesigner: PdfTemplateDesigner | undefined;
  /** The kernel's reading of the populated form on the page, once it has one. */
  readonly templateInspection: PdfTemplateInfo | undefined;
  /** Puts the layout on the page; resolves once its designer is up. */
  selectLayout(id: string): Promise<void>;
  /**
   * Maps every unmapped field of the populated form on the page whose name matches a form
   * component's id or label; returns how many it mapped. The bar's button passes no options:
   * one undo step per field. `batch` (the browser-assistant tools) lands every
   * mapping as one step; `around` runs each write.
   */
  suggestMappings(options?: SuggestMappingsOptions): number;
  newLayout(options: NewPdfLayoutOptions): PdfLayoutDocument;
  addLayout(layout: PdfLayoutDocument, options?: { select?: boolean | undefined }): void;
  /** A populated form over `source`: the layout is added under a name (the file's, say) and put on the page. */
  addTemplateLayout(source: PdfTemplateSource, name: string): PdfTemplateLayout;
  replaceLayout(id: string, layout: PdfLayoutDocument): void;
  renameLayout(id: string, name: string): void;
  duplicateLayout(id: string, options?: DuplicatePdfLayoutOptions & { select?: boolean | undefined }): PdfLayoutDocument;
  removeLayout(id: string): void;
  setDefaultLayout(id: string): void;
  /**
   * Moves the layout to `toIndex` among the others (clamped to the list): where its condition is
   * tried. The default is written down first when none is declared, so a move never
   * changes what prints when no condition holds; the page and its undo history stay.
   */
  moveLayout(id: string, toIndex: number): void;
  /** Opens the Add popover (what an overview's New does), under `anchor` when given; `options` as the shell's add passes them. */
  openAdd(anchor?: HTMLElement, options?: BuilderModeAddOptions): void;
  previewPdf(): Promise<void>;
  /**
   * `runtime` replaces the host's (Try it's); `byAnswers` renders no layout by name, so
   * the answers choose it or the declared default does.
   */
  renderPdf(options?: { layoutId?: string | undefined; runtime?: RenderableRuntime | undefined; byAnswers?: boolean | undefined }): Promise<RenderFormPdfResult>;
  /** The answers the previews show changed (Back to editing after Try it): the layout on the page repaints with them. */
  valuesChanged(): void;
  /**
   * On a populated form: a form field for every template field nothing fills, each filled from
   * it — or from the form's own field of that name. Needs the `form` option. `around`
   * (the browser-assistant tools) runs the form's insert and the layout's write.
   */
  createFormFields(options?: CreateFormFieldsOptions): Promise<CreateFormFieldsResult>;
  /**
   * Renders the PDF and shows it in the preview dialog, as Preview PDF does, and says what it
   * rendered: the facts, never the file or a kernel message. `{ error, busy: true }` while
   * another preview renders. A preview the browser-assistant tools ask for
   * takes no focus while the person's focus is elsewhere.
   *
   * @internal
   */
  previewReport(options?: PdfPreviewReportOptions): Promise<PdfPreviewReport | { error: string; busy?: true }>;
  /**
   * Puts `next` in the catalog's place as the mode's own catalog actions do (a move, a default,
   * a layout added): designers follow it and keep their undo histories, the person's included,
   * where the `pdfConfiguration` setter would start every designer over. The exact inverse of
   * an assistant's catalog action; `subjectId` names the layout it concerns. No step
   * of the form's history, unless translations move with it (a layout taken away or brought
   * back): then one step holds the change and its wording.
   *
   * @internal
   */
  applyCatalogForAgent(next: PdfConfiguration, subjectId: string): void;
  /**
   * The layout on the page: its id, whether its designer is up, and for a populated form whose
   * PDF has been read, how many fields it has. No id when the form has no layout.
   *
   * @internal
   */
  openState(): PdfOpenState;
  /**
   * Waits up to `timeoutMs` for the layout on the page to be up, and for a populated form's PDF
   * to be read: `"ready"`, `"failed"` (the designer's chunk, the build or the read failed, or a
   * populated form's PDF has no executor to read it) or `"loading"` when the time ran out first,
   * or when the person put another layout on the page meanwhile (the caller asks again). Opens
   * it as the person's click on its tab does (a read that failed is tried again) unless a build
   * is already under way.
   *
   * @internal
   */
  whenOpenReady(timeoutMs: number): Promise<"ready" | "loading" | "failed">;
}

/** How {@link PdfBuilderMode.suggestMappings} writes. */
export interface SuggestMappingsOptions {
  /** Every mapping as one step on the layout's undo history; absent, one step per field. */
  batch?: boolean | undefined;
  /** Runs each write: the browser-assistant tools mark their own steps by it. Absent, the write runs as it is. */
  around?: ((step: () => void) => void) | undefined;
}

/** How {@link PdfBuilderMode.createFormFields} writes. */
export interface CreateFormFieldsOptions {
  /** Runs the form's insert and the layout's write, never anything across a wait. Absent, each runs as it is. */
  around?: ((step: () => void) => void) | undefined;
}

/** What "Create form fields" did. */
export interface CreateFormFieldsResult {
  /** The components inserted into the form, by id. */
  added: string[];
  /** The template fields it filled: from the new components and from the ones the form had. */
  mapped: number;
  /** How many of those it filled from a component the form already had. */
  matched: number;
  /** The template fields nothing was built for, and why. */
  skipped: Array<{ pdfField: string; reason: string }>;
  /** Why it did nothing, when it did nothing. */
  error?: string;
  /**
   * Which refusal `error` words, for a caller that must not read the words:
   * no populated form on the page or no form to add to (`no-form`), the form's or the layout's
   * unsaved edits (`form-unsaved`, `layout-unsaved`), a prompt the form held the insert for
   * (`holding`), or the insert refused (`refused`).
   */
  errorCode?: "no-form" | "form-unsaved" | "layout-unsaved" | "holding" | "refused";
}

/** Where {@link PdfBuilderMode.previewReport} renders from, and where its dialog goes. */
export interface PdfPreviewReportOptions {
  /** The layout to print; absent, the answers choose, as a download that names none. */
  layoutId?: string | undefined;
  /** The answers to print with (Try it's, or the host's sample ones); absent, the mode's own runtime. */
  runtime?: RenderableRuntime | undefined;
  /** Where the dialog goes while the mode is not on the page: the shell's shadow root. Absent, the root the mode was last given. */
  root?: ShadowRoot | undefined;
}

/** What a preview rendered: what the dialog says about it, without the file or any kernel text. */
export interface PdfPreviewReport {
  layoutId: string;
  /** How the layout was chosen. */
  layoutChoice: RenderFormPdfResult["layoutChoice"];
  layoutKind: RenderFormPdfResult["layoutKind"];
  pageCount: number;
  /** The render's warnings by code (and component), never their message. */
  warnings: Array<{ code: string; componentId?: string }>;
  /** A populated form's fields: how many the answers filled, how many stayed empty. */
  fields?: { filled: number; empty: number };
}

/** The layout on the page, as {@link PdfBuilderMode.openState} reports it. */
export interface PdfOpenState {
  id?: string;
  /** Its designer is up. */
  ready: boolean;
  /** A populated form whose PDF has been read: how many fields the PDF has. */
  template?: { fields: number };
}

function readTitle(root: ComponentNode): string | undefined {
  const title = (root.configuration as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : undefined;
}

function nameText(name: string | undefined): string {
  return name ?? "";
}

const esc = escapeHtml;

/** The mode's own chrome: the Preview button on the bar, the template surface, the dialogs. */
export const PDF_BUILDER_MODE_STYLES = `
  ${PDF_DESIGNER_PANEL_STYLES}
  /*
   * The preview a browser assistant opened while the person was busy elsewhere:
   * not modal, so it takes no focus and leaves the page live, yet sits where the modal one does,
   * over the shell, not in the flow of the shadow root it was appended to.
   */
  dialog.dpd[data-preview-quiet] { position: fixed; inset: ${MODAL_INSET}; z-index: var(--db-z-popover); }
`;

/** What the kernel said about one PDF, kept so a tab visited again is not read again. */
interface Inspected {
  source: PdfTemplateSource;
  bytes: Uint8Array;
  info: PdfTemplateInfo;
}

/** One layout's editing state: its controller, the designer over it, and what it was built over. */
interface LayoutEntry {
  id: string;
  controller: BuilderController;
  kind?: PdfLayoutDocument["kind"] | undefined;
  designer?: PdfDesigner | undefined;
  template?: PdfTemplateDesigner | undefined;
  /** What the designer was built over; a change to any of it rebuilds or refreshes. */
  built?: { rootJson: string; valuesJson: string; template?: PdfTemplateSource | undefined } | undefined;
  token: number;
  /** Builds of its designer under way (`whenOpenReady` waits for them rather than starting another). */
  builds: number;
  /** The last build of its designer, or the last read of its PDF, failed; cleared when the next one starts. */
  failed?: boolean | undefined;
  /** The layout as last reported to the host, so a repaint that changed nothing (a draft keystroke) is not reported again. */
  reportedJson?: string | undefined;
  /** A populated form's canvas surface: a status line over the page viewer. */
  surface?: HTMLElement | undefined;
  statusEl?: HTMLElement | undefined;
  /** The line under the status naming the widgets whose value map holds entries that match nothing; hidden when none. */
  staleEl?: HTMLElement | undefined;
  /** The note Suggest mappings leaves (what is mapped, placed and matched), with its Dismiss; hidden until a suggestion ran. */
  noteEl?: HTMLElement | undefined;
  viewer?: TemplatePageViewer | undefined;
  /** What the root's inspector notes about the layout's condition: the controller's `notes` hook, one per entry. */
  notes: NonNullable<BuilderControllerOptions["notes"]>;
  unsubscribe: () => void;
}

function readConfig(node: ComponentNode | undefined): Record<string, unknown> {
  const configuration = node?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

/** How many pruned subtrees the mode holds against an Undo (see `PdfBuilderModeImpl.pruned`). */
const PRUNED_KEPT = 200;

class PdfBuilderModeImpl implements PdfBuilderMode {
  public readonly id = PDF_BUILDER_MODE;
  public readonly label = "PDF";
  public readonly barActions: HTMLElement[];
  public readonly overlays: HTMLElement[];
  public readonly styles = PDF_BUILDER_MODE_STYLES;
  /**
   * A Rules tab on the layout's root only: its condition, stored as the root's `when`.
   * No other node has one: nothing reads a layout node's `rules`; a section, box or
   * table follows its hidden fields through `skipWhenEmpty`. A layout's root is a document, not
   * a form, so the strip's settings panel says so. Kept as one object: the inspector
   * drops its rule edits in progress when it changes.
   */
  public readonly inspector: { rules: BuilderModeRules; settingsLabel: string };
  public readonly documents: BuilderDocuments;
  /** The Form panel's PDF group on the form's own tab: the order in words, read-only. */
  public readonly formSettings: BuilderFormSettings;

  /** The builder's words per locale, read live: the host's option, or the one the shell assigns when the mode is added (absent: English). */
  public textCatalog: (() => BuilderTextCatalog | undefined) | undefined;

  private readonly options: PdfBuilderModeOptions;
  private readonly model: PdfModeModel;
  private context: BuilderModeContext | undefined;
  /** Whether the mode is the page's: the sheet's field previews only refresh then. */
  private active = false;
  /** Where focus goes when the preview dialog closes: Try it's Preview PDF, or the bar's. */
  private previewOrigin: "bar" | "try" = "bar";
  private readonly entries = new Map<string, LayoutEntry>();
  /**
   * Translations pruned with a layout, node, mapping or area, by the prefix they lived under,
   * kept until the edit is taken back: the designer's Undo and an agent's catalog
   * undo bring the thing back, and its wording with it, because the map is the form's and its
   * history is not the layout's. Another definition empties it.
   */
  private readonly pruned = new Map<string, Array<{ locale: string; address: TextAddress; entry: TranslationEntry }>>();
  /** What the panels point at while the form has no layout: an empty tree, no palette. */
  private readonly idleController = new BuilderController({ componentTypes: [] });
  private readonly historyListeners = new Set<() => void>();
  /**
   * The form's mutations, heard from the first activation until the mode is disposed: a held
   * step undone or redone while the PDF workspace is not up (the Form workspace's Undo) is held
   * again with the marks as they stand then, so Redo reaches it back on the page. Only a step
   * made while a layout is on the page is held as new (`formSteps.heard`).
   */
  private formMutationOff: (() => void) | undefined;
  /** The form controller {@link formMutationOff} hears. */
  private heardForm: BuilderController | undefined;
  /** The form's steps made while a layout is on the page, reached from there ({@link formStepsOnPage}). */
  private readonly formSteps = formStepsOnPage(
    () => this.options.form?.(),
    this.entries,
    this.historyListeners,
    () => this.model.configuration,
    (before, after) => this.blockCommand(before, after),
    () => this.active
  );
  /** The canvas's surface while the form has no layout, built on first need. */
  private emptyEl: HTMLElement | undefined;
  /** What the empty state was last drawn as, so a repaint with the same words leaves it be. */
  private emptyHtml = "";
  /** Set when the designer's chunk failed to load and the layout on the page needs it; cleared by the next try (Retry). */
  private chunkFailure: unknown;
  private failedEl: HTMLElement | undefined;
  private readonly inspections: Inspected[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly settingsListeners = new Set<() => void>();
  /** What the conditions, the order and the default were when the Form panel's group was last told (see {@link conditionsSignature}). */
  private settingsSignature = "";
  private supportValue: PdfBuilderModeSupport | undefined;
  private supportLoader: (() => Promise<PdfBuilderModeSupport>) | undefined;
  private supportPromise: Promise<PdfBuilderModeSupport> | undefined;
  private previewBusy = false;
  private formulaFunctionsValue: FormulaFunctionsSource | undefined;
  /**
   * Set while the mode pushes an edit into an open tree itself — a layout's new name, a form
   * rename followed into its condition — so the controller's own change is not reported twice.
   */
  private syncingName = false;
  /**
   * Set while an Undo or a Redo of a form rename's follow-up writes what the built trees did
   * not already carry into the catalog (`followFormStep`), so no designer is built again over a
   * tree that followed the step in place.
   */
  private carryingFollow = false;

  private readonly suggestButtonEl: HTMLButtonElement;
  private readonly createFieldsButtonEl: HTMLButtonElement;
  private readonly previewButtonEl: HTMLButtonElement;
  private readonly previewDialogEl: HTMLDialogElement;
  private readonly addEl: HTMLElement;
  /** The Preview dialog and the Add popover over their elements, once the designer's chunk is in (`mountPanels`). */
  private previewDialog: PreviewDialog | undefined;
  private addPopover: AddPopover | undefined;
  /** The designer's chunk once it is in: whatever holds a designer or an open layout's viewer was made by it. */
  private chunk: PdfDesignerModule | undefined;
  /** How the add flow on the page was started, until it ends. */
  private addOptions: BuilderModeAddOptions | undefined;

  constructor(options: PdfBuilderModeOptions) {
    if (typeof document === "undefined") {
      throw new Error("createPdfBuilderMode needs a DOM");
    }
    this.options = options;
    this.textCatalog = options.textCatalog ? () => options.textCatalog?.() : undefined;
    this.model = new PdfModeModel(this.seed(), options.layoutId);
    // The first seed is told like every later one: a definition saved from here drops them.
    this.reportUnusable();

    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.setAttribute("data-suggest-mappings", "");
    suggest.hidden = true;
    suggest.addEventListener("click", () => this.suggestMappings());
    const create = document.createElement("button");
    create.type = "button";
    create.setAttribute("data-create-form-fields", "");
    create.hidden = true;
    create.addEventListener("click", () => void this.createFormFields());
    const preview = document.createElement("button");
    preview.type = "button";
    // The primary action: the canvas toolbar draws it as an accent pill beside Try it.
    preview.setAttribute("data-builder-primary", "");
    preview.setAttribute("data-preview-pdf", "");
    preview.addEventListener("click", () => void this.previewPdf());
    this.suggestButtonEl = suggest;
    this.createFieldsButtonEl = create;
    this.previewButtonEl = preview;
    this.barActions = [suggest, create, preview];

    const previewDialogEl = document.createElement("dialog");
    previewDialogEl.setAttribute("data-preview-dialog", "");
    // A preview an assistant opened without focus (`showWithoutFocus`) is an ordinary one once closed.
    previewDialogEl.addEventListener("close", () => previewDialogEl.removeAttribute("data-preview-quiet"));
    const addEl = document.createElement("div");
    addEl.setAttribute("data-add-popover", "");
    // Hidden until the popover is drawn into it (the chunk's): an empty element takes no room meanwhile.
    addEl.hidden = true;
    this.previewDialogEl = previewDialogEl;
    this.addEl = addEl;
    this.overlays = [previewDialogEl, addEl];

    this.documents = {
      // The shell's words for a document here: "Add a layout", "Layout options".
      noun: "layout",
      list: () => this.documentList(),
      selectedId: () => this.model.selected()?.id,
      select: (id) => this.selectLayout(id),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      add: (anchor, _kind, options) => this.openAdd(anchor, options),
      rename: (id, name) => this.renameLayout(id, name),
      duplicate: (id) => {
        this.duplicateLayout(id, { select: true });
      },
      // The last one too: a form need not have a layout.
      remove: (id) => this.removeLayout(id),
      setDefault: (id) => this.setDefaultLayout(id),
      // One place up or down: where the layout's condition is tried.
      move: (id, offset) => {
        const at = this.model.layouts.findIndex((layout) => layout.id === id);
        if (at < 0) {
          return;
        }
        try {
          this.moveLayout(id, at + offset);
        } catch (error) {
          this.options.onError?.("The layout could not be moved", error);
        }
      }
    };

    const settingsLabel = (): string => this.text("pdf.settings.label");
    this.inspector = {
      rules: {
        descriptors: (nodeType) => pdfLayoutRuleDescriptors(nodeType, this.words()),
        fieldOptions: () => pdfConditionFieldOptions(this.conditionContext()),
        formulaFields: () => pdfConditionFormulaFields(this.conditionContext()),
        // Asked on every paint: where the layout on the page stands follows a move, a new default
        // and the other layouts' conditions, which reach its controller as a repaint only.
        note: () => pdfLayoutRulesNote(this.conditionContext(), this.liveConfiguration(), this.model.selected()?.id)
      },
      // Read on every paint: the strip's settings panel follows the builder's language.
      get settingsLabel(): string {
        return settingsLabel();
      }
    };

    this.formSettings = {
      title: "PDF",
      // Nothing is chosen here: the default is set from the documents menu, and a
      // drafted row would let a pending Form-panel draft override it.
      rows: () => [],
      readOnlyRows: () => this.orderRows(),
      subscribe: (listener) => {
        this.settingsListeners.add(listener);
        return () => {
          this.settingsListeners.delete(listener);
        };
      }
    };

    // Last, once the controls exist to reflect it.
    this.support = options.support;
  }

  // --- the mode contract --------------------------------------------------

  public get controller(): BuilderController {
    const selected = this.model.selected();
    return selected ? this.entryFor(selected.id).controller : this.idleController;
  }

  /** The form's steps made while a layout is on the page, while one is live ({@link formSteps}); else none, and the layout's own Undo. */
  public history(): BuilderModeHistory | undefined {
    return this.formSteps.after(undefined);
  }

  public subscribeHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  public async activate(context: BuilderModeContext): Promise<void> {
    this.context = context;
    this.active = true;
    // A form step made from a panel over the page (a test removed); the mode's follow-ups go with its edits, and a catalog action marks itself (`formSteps.stepped`).
    const form = this.options.form?.();
    if (form !== this.heardForm) {
      this.formMutationOff?.();
      this.heardForm = form;
      this.formMutationOff = form?.on?.("mutation", (event) => this.formSteps.heard(event));
    }
    await this.ensureFresh();
    // As the Journeys mode: a designer that cannot load refuses the activation, the shell says so and stays where it was.
    if (this.chunkFailure !== undefined && this.model.selected() && !this.chunk) {
      throw this.chunkFailure;
    }
    this.applyView();
  }

  public deactivate(): void {
    this.active = false;
    // The form is still heard (`formMutationOff`): a held step it undoes or redoes meanwhile stays held.
    // The designers, their history and drafts stay for the round trip back.
    this.addPopover?.close();
  }

  public dispose(): void {
    this.formMutationOff?.();
    this.formMutationOff = undefined;
    this.heardForm = undefined;
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.previewDialog?.close();
    this.addPopover?.close();
    this.context = undefined;
    this.active = false;
    // Mounted into the shell's root by a Preview PDF from another workspace: taken away with the mode.
    const root = this.overlays[0]?.getRootNode();
    this.overlays[0]?.remove();
    if (root instanceof ShadowRoot) {
      root.querySelector(`style[data-mode-style="${this.id}-preview"]`)?.remove();
    }
  }

  // --- executor -------------------------------------------------------------

  public get support(): PdfBuilderModeSupportSource | undefined {
    return this.supportValue ?? this.supportLoader;
  }

  public set support(value: PdfBuilderModeSupportSource | undefined) {
    if (typeof value === "function") {
      this.supportValue = undefined;
      this.supportLoader = value;
    } else {
      this.supportValue = value;
      this.supportLoader = undefined;
    }
    this.supportPromise = undefined;
    this.syncControls();
    // A populated form waiting for its fields reads them now that there is something to read them with.
    if (this.context && this.canExecute() && this.model.selected()?.kind === "template") {
      void this.ensureFresh().then(() => this.applyView());
    }
  }

  private canExecute(): boolean {
    return this.supportValue !== undefined || this.supportLoader !== undefined;
  }

  private ensureSupport(): Promise<PdfBuilderModeSupport> {
    if (this.supportValue) {
      return Promise.resolve(this.supportValue);
    }
    const loader = this.supportLoader;
    if (!loader) {
      return Promise.reject(new Error("No PDF executor: assign the mode's support"));
    }
    this.supportPromise ??= loader().then(
      (support) => {
        this.supportValue = support;
        this.syncControls();
        return support;
      },
      (error: unknown) => {
        this.supportPromise = undefined;
        this.options.onError?.("The PDF executor could not load", error);
        throw error;
      }
    );
    return this.supportPromise;
  }

  // --- the catalog ------------------------------------------------------------

  public get pdfConfiguration(): PdfConfiguration {
    return this.model.configuration;
  }

  public set pdfConfiguration(value: PdfConfiguration) {
    this.reseed({ ...this.seed(), pdf: value });
  }

  /** The mode's part of Try it: the PDF card's label, and Preview PDF with the tried runtime in the mode's own dialog from any workspace. */
  public readonly tryIt = {
    pdf: {
      label: (): string => {
        const layout = this.currentLayout();
        if (!layout) {
          return this.text("pdf.tryIt.derived");
        }
        const paper = layout.kind === "generated" ? paperName(layout, this.words()) : undefined;
        return paper ? `${this.layoutName(layout)} · ${paper}` : this.layoutName(layout);
      },
      // In the PDF workspace the open layout is previewed; from another, the answers choose.
      preview: async (runtime: RenderableRuntime, context?: { workspace: string; root?: ShadowRoot }): Promise<void> =>
        {
          this.previewOrigin = "try";
          await this.showPreview({ runtime, byAnswers: context !== undefined && context.workspace !== "pdf", root: context?.root });
        }
    }
  };

  /** The answers the sheet's field previews show changed: refresh them. */
  public valuesChanged(): void {
    if (this.context && this.active) {
      void this.ensureFresh().then(() => this.applyView());
    }
  }

  /** The plugin formula functions the host wired: the layouts' field previews work them out. */
  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.formulaFunctionsValue;
  }

  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    if (value === this.formulaFunctionsValue) {
      return;
    }
    this.formulaFunctionsValue = value;
    for (const entry of this.entries.values()) {
      const designer = entry.designer;
      if (designer) {
        void designer.setFormulaFunctions(value).then(() => {
          if (entry.designer === designer) {
            entry.controller.repaintPreview();
          }
        });
      }
    }
  }

  public reseed(seed: PdfModeSeed): void {
    this.model.reseed(seed);
    this.pruned.clear();
    this.reportUnusable();
    // Another form's layouts: every designer starts over.
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.syncControls();
    if (this.context) {
      void this.ensureFresh().then(() => this.applyView());
    }
  }

  public get layouts(): PdfLayoutDocument[] {
    return this.model.layouts;
  }

  public get unusableLayouts(): readonly string[] {
    return this.model.unusable;
  }

  /** Tells the host which declared layouts the last seed left out, and why. */
  private reportUnusable(): void {
    const unusable = this.model.unusable;
    if (unusable.length > 0) {
      this.options.onError?.(builderPlural("pdf.unusable", unusable.length, { list: unusable.join(" | ") }, this.words()));
    }
  }

  public get layoutId(): string | undefined {
    return this.model.selected()?.id;
  }

  public set layoutId(value: string | undefined) {
    if (value === undefined) {
      this.model.layoutId = undefined;
      this.syncControls();
      void this.ensureFresh().then(() => this.applyView());
      return;
    }
    this.selectLayout(value);
  }

  public get pdfLayout(): PdfLayoutDocument | undefined {
    return this.currentLayout();
  }

  public get ready(): boolean {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    if (!selected || !entry?.built || entry.kind !== selected.kind) {
      return false;
    }
    return selected.kind === "template" ? entry.template !== undefined : entry.designer?.layout.id === selected.id;
  }

  public get designer(): PdfDesigner | undefined {
    const selected = this.model.selected();
    return selected ? this.entries.get(selected.id)?.designer : undefined;
  }

  public get templateDesigner(): PdfTemplateDesigner | undefined {
    const selected = this.model.selected();
    return selected ? this.entries.get(selected.id)?.template : undefined;
  }

  public get templateInspection(): PdfTemplateInfo | undefined {
    return this.templateDesigner?.inspection;
  }

  /** Puts the layout on the page; resolves once its designer is up (or was already). */
  public selectLayout(id: string): Promise<void> {
    const layout = this.model.require(id);
    if (this.model.selected()?.id === id) {
      return this.ensureFresh().then(() => this.applyView());
    }
    this.model.layoutId = id;
    this.syncControls();
    this.options.onSelect?.({ layoutId: id, layout });
    return this.ensureFresh().then(() => this.applyView());
  }

  /** One step of the form's history, as every catalog action is. */
  public addLayout(layout: PdfLayoutDocument, options: { select?: boolean | undefined } = {}): void {
    const next = addPdfLayout(this.model.configuration, layout);
    this.refuseHeavyTemplate(next, layout);
    this.formSteps.stepped(() => this.applyConfiguration(next, layout, "layouts", options.select ? layout.id : undefined));
  }

  public newLayout(options: NewPdfLayoutOptions): PdfLayoutDocument {
    const name = options.name.trim();
    if (name === "") {
      throw new Error("A layout needs a name");
    }
    const id = uniquePdfLayoutId(
      pdfLayoutIdFromName(name),
      this.model.layouts.map((layout) => layout.id)
    );
    const select = options.select !== false;
    if (options.from === "copy") {
      const from = this.model.selected();
      if (!from) {
        throw new Error("There is no layout to copy");
      }
      return this.duplicateLayout(from.id, { id, name, select });
    }
    const layout = newGeneratedPdfLayout({ id, name, formRoot: this.options.formRoot(), from: options.from, title: this.title() });
    this.addLayout(layout, { select });
    return layout;
  }

  public addTemplateLayout(source: PdfTemplateSource, name: string): PdfTemplateLayout {
    const layout = this.templateLayoutFor(source, name);
    const next = addPdfLayout(this.model.configuration, layout);
    this.refuseHeavyTemplate(next, layout);
    // The layout carries its template (the bytes, or the host's reference), so the step's Redo
    // brings back a layout whose designer reads the same PDF again.
    this.formSteps.stepped(() => this.applyConfiguration(next, layout, "template", layout.id));
    return layout;
  }

  /** The layout a populated form over `source` would be, under the name typed (a blank one takes "Paper form"). */
  private templateLayoutFor(source: PdfTemplateSource, name: string): PdfTemplateLayout {
    const typed = name.trim() || this.text("pdf.newName.paper");
    const id = uniquePdfLayoutId(
      pdfLayoutIdFromName(typed),
      this.model.layouts.map((layout) => layout.id)
    );
    return { id, kind: "template", name: typed, template: source, fields: [] };
  }

  /**
   * Why an uploaded template would make the form unloadable, in the builder's words: the
   * definition carries its bytes as base64, and a form past the load limit saves and never
   * opens again. `replacing` names the layout the new one takes the place of, whose own
   * template is not counted again. `undefined` when it fits, or when the template is the host's
   * (its bytes stay out of the definition).
   */
  private heavyTemplateProblem(next: PdfConfiguration, layout: PdfLayoutDocument, replacing?: string): string | undefined {
    if (layout.kind !== "template" || layout.template.storage !== "base64") {
      return undefined;
    }
    const before = replacing === undefined ? undefined : this.model.layouts.find((candidate) => candidate.id === replacing);
    if (before?.kind === "template" && sameTemplate(before.template, layout.template)) {
      return undefined;
    }
    return embeddedTemplateProblem(layout.template, layout.template.name, this.options.definitionBytes?.(next), this.words());
  }

  /** Throws the reason (see {@link heavyTemplateProblem}) before anything about the form changes. */
  private refuseHeavyTemplate(next: PdfConfiguration, layout: PdfLayoutDocument, replacing?: string): void {
    const problem = this.heavyTemplateProblem(next, layout, replacing);
    if (problem !== undefined) {
      throw new Error(problem);
    }
  }

  public replaceLayout(id: string, layout: PdfLayoutDocument): void {
    this.model.require(id);
    const onPage = this.model.selected()?.id === id;
    const next = replacePdfLayout(this.model.configuration, id, layout);
    this.refuseHeavyTemplate(next, layout, id);
    const apply = (): void => this.applyConfiguration(next, layout, "layouts", onPage && layout.id !== id ? layout.id : undefined);
    // Under the same id it is no step: a new name alone is `renameLayout`'s, any other change
    // starts its designer over. Under another id it is one step of the form's history, and the
    // layout's translations go with it.
    if (layout.id === id) {
      apply();
      return;
    }
    this.formSteps.stepped(() => {
      apply();
      rewriteFormTranslations(this.options.form?.(), (map) => moveTranslations(map, { kind: "pdf", owner: id }, { kind: "pdf", owner: layout.id }), undefined, [{ kind: "pdf", from: id, to: layout.id }]);
    });
  }

  /** The layout under another name: an empty name is no name, and an unchanged one keeps its translations. */
  public renameLayout(id: string, name: string): void {
    const layout = this.model.require(id);
    const typed = name.trim();
    const next: PdfLayoutDocument = { ...layout };
    if (typed === "") {
      delete (next as { name?: string }).name;
    } else if (typed !== nameText(layout.name)) {
      next.name = typed;
    } else {
      return;
    }
    // One step of the form's history, built designer or not (rule 13): its tree takes the name unrecorded (`pushName`).
    this.formSteps.stepped(() => this.replaceLayout(id, next));
  }

  /**
   * The layouts' default texts as a document the form's history can rewrite: Make
   * default promotes a translation to be the default and the layouts must hold the new string in
   * the same undo step as the map; the Languages workspace's Apply of a default does the same.
   * The translations themselves are the definition's map and never read from the layouts.
   */
  public localeDocument(): OutsideDocument {
    return {
      id: "pdf",
      read: () => this.model.configuration,
      write: (value) => this.rewriteDefaults(value as PdfConfiguration),
      texts: () => pdfOutsideTexts(this.model.configuration),
      setDefaults: (value, edits) => setPdfLayoutDefaults(value as PdfConfiguration, edits)
    };
  }

  public languageTexts(words?: BuilderTextOptions): TranslatableText[] {
    return pdfLayoutTexts(this.model.configuration, this.locale(), this.textSources(), words ?? this.words());
  }

  /** The catalog replaced by `next` with only its default texts changed; the layout that changed is the change's subject. */
  private rewriteDefaults(next: PdfConfiguration): void {
    const after = pdfLayoutsOf(next);
    const changed = pdfLayoutsOf(this.model.configuration).findIndex((layout, index) => JSON.stringify(layout) !== JSON.stringify(after[index]));
    const layout = after[Math.max(0, changed)];
    if (!layout) {
      return;
    }
    this.applyConfiguration(next, layout, "layouts");
  }

  public removeLayout(id: string): void {
    const removed = this.model.require(id);
    const next = removePdfLayout(this.model.configuration, id);
    // One step of the form's history whether or not a translation moved: Undo brings the layout
    // back on a form without translations too. Its addresses are pruned from every language
    // in that step: one Undo brings the layout and its wording back.
    this.formSteps.stepped(() => {
      const entry = this.entries.get(id);
      if (entry) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
      this.applyConfiguration(next, removed, "layouts", this.model.selected()?.id === id ? pdfLayoutsOf(next)[0]?.id : undefined);
      rewriteFormTranslations(this.options.form?.(), (map) => this.pruneHeld(map, { kind: "pdf", owner: id }));
    });
  }

  public duplicateLayout(id: string, options: DuplicatePdfLayoutOptions & { select?: boolean | undefined } = {}): PdfLayoutDocument {
    const { select, ...rest } = options;
    // The copy is of the layout as it stands on the page, unsaved drafts aside.
    const configuration =
      this.model.selected()?.id === id && this.currentLayout()
        ? replacePdfLayout(this.model.configuration, id, this.currentLayout()!)
        : this.model.configuration;
    const copied = duplicatePdfLayout(configuration, id, { text: this.words(), ...rest });
    // A copy of an uploaded template embeds its bytes a second time.
    this.refuseHeavyTemplate(copied.configuration, copied.layout);
    // The copy carries the original's translations under its own id; a copy that
    // an agent's undo took away and now returns has its own held ones instead (`applyCatalogForAgent`).
    // The copy and its wording are one step of the form's history.
    this.formSteps.stepped(() => {
      this.applyConfiguration(copied.configuration, copied.layout, "layouts", select ? copied.layout.id : undefined);
      rewriteFormTranslations(this.options.form?.(), (map) => copyTranslations(map, "pdf", id, copied.layout.id));
    });
    return copied.layout;
  }

  /** One step of the form's history; Undo puts back the default as it was declared, none included. */
  public setDefaultLayout(id: string): void {
    this.formSteps.stepped(() => this.applyConfiguration(setDefaultPdfLayout(this.model.configuration, id), this.model.require(id), "layouts"));
  }

  public moveLayout(id: string, toIndex: number): void {
    const layout = this.model.require(id);
    if (!Number.isFinite(toIndex)) {
      throw new Error("A PDF layout's new place must be a number");
    }
    const layouts = this.model.layouts;
    const place = Math.max(0, Math.min(layouts.length - 1, Math.trunc(toIndex)));
    if (layouts[place]?.id === id) {
      // Already there: nothing moves, and nothing is written down for it.
      return;
    }
    // The same layouts under the same page: no designer is rebuilt, so the one on the page
    // keeps its history, drafts and selection. One step of the form's history.
    this.formSteps.stepped(() => this.applyConfiguration(movePdfLayout(this.model.configuration, id, place), layout, "layouts"));
  }

  public applyCatalogForAgent(next: PdfConfiguration, subjectId: string): void {
    // The layout the change concerns: as `next` holds it, or as it stood when `next` takes it away.
    const layout = pdfLayoutsOf(next).find((candidate) => candidate.id === subjectId) ?? this.model.layouts.find((candidate) => candidate.id === subjectId);
    if (!layout) {
      throw new Error(`There is no PDF layout "${subjectId}"`);
    }
    // The catalog's own path (followCatalog and all): the page stays where it is, and no designer
    // over a layout the change leaves alone is rebuilt, so the undo histories stay.
    const blockBefore = this.model.configuration;
    const before = this.model.layouts.map((candidate) => candidate.id);
    // Whatever step this writes (only when wording moves) is one entry, held by the designer on
    // the page as a catalog step is: the bar's Undo there takes the restore back first.
    this.formSteps.joined(() => {
      this.applyConfiguration(next, layout, "layouts");
      const kept = new Set(pdfLayoutsOf(next).map((candidate) => candidate.id));
      const gone = before.filter((layoutId) => !kept.has(layoutId));
      const came = [...kept].filter((layoutId) => !before.includes(layoutId));
      if (gone.length > 0 || came.length > 0) {
        // A layout the change took away has its wording pruned (and held); one it brings back, as
        // an agent's undo of a removal does, has what was held written again. When the wording
        // moves that is a step of the form's history, and it holds the catalog's change too, so its
        // Undo takes back the whole change (a restore), never the wording alone.
        const defaults = this.defaultsOf(pdfLayoutsOf(next).filter((candidate) => came.includes(candidate.id)));
        rewriteFormTranslations(
          this.options.form?.(),
          (map) => this.restoreHeld(gone.reduce((pruned, layoutId) => this.pruneHeld(pruned, { kind: "pdf", owner: layoutId }), map), defaults),
          this.blockCommand(blockBefore, this.model.configuration)
        );
      }
    });
  }

  public openState(): PdfOpenState {
    const selected = this.model.selected();
    if (!selected) {
      return { ready: false };
    }
    const inspection = selected.kind === "template" && this.ready ? this.templateInspection : undefined;
    return { id: selected.id, ready: this.ready, ...(inspection ? { template: { fields: inspection.fields.length } } : {}) };
  }

  public async whenOpenReady(timeoutMs: number): Promise<"ready" | "loading" | "failed"> {
    const id = this.model.selected()?.id;
    if (id === undefined || this.openReadiness() === "ready") {
      return "ready";
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    // Opened as the person's click on its tab opens it — which reads a PDF whose read failed
    // again — unless a build is already under way, which would only be started over.
    let opened = (this.entries.get(id)?.builds ?? 0) > 0 ? undefined : false;
    let threw = false;
    if (opened === false) {
      const opening = this.selectLayout(id).then(
        () => {
          opened = true;
        },
        () => {
          threw = true;
        }
      );
      // The deadline's timer goes once the layout has opened: an open designer answers in
      // milliseconds, and the tool's 10 s would otherwise stay armed after every call.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
      try {
        await Promise.race([opening, late]);
      } finally {
        clearTimeout(timer);
      }
    }
    for (;;) {
      if (threw) {
        return "failed";
      }
      // The person opened another layout meanwhile: what is on the page now is not what the
      // caller checked, so it asks again (its preconditions then speak about that layout).
      if (this.model.selected()?.id !== id) {
        return "loading";
      }
      const state = this.openReadiness();
      // A failure counts once the build this call waits for has finished, not an earlier one's.
      const settled = opened !== false && (this.entries.get(id)?.builds ?? 0) === 0;
      if (state === "ready" || (state === "failed" && settled)) {
        return state;
      }
      if (Date.now() >= deadline) {
        return "loading";
      }
      await wait(Math.min(25, deadline - Date.now()));
    }
  }

  /** Where the layout on the page stands: up (and read, for a populated form), failing, or on its way. */
  private openReadiness(): "ready" | "loading" | "failed" {
    const selected = this.model.selected();
    if (!selected) {
      return "ready";
    }
    if (!this.chunk && this.chunkFailure !== undefined) {
      return "failed";
    }
    // A populated form's PDF is read by the PDF executor: with none assigned and no earlier
    // reading to build from, its designer only says it is waiting, so waiting is no use. A
    // host that assigns one later gets the read then (the `support` setter), and a call again.
    if (selected.kind === "template" && !this.canExecute() && !this.inspectionFor(selected.template)) {
      return "failed";
    }
    const entry = this.entries.get(selected.id);
    if (!this.ready) {
      return entry?.failed ? "failed" : "loading";
    }
    if (selected.kind !== "template" || this.templateInspection !== undefined) {
      return "ready";
    }
    return entry?.failed ? "failed" : "loading";
  }

  /**
   * A form component was given a new id on the Form tab: every layout's condition
   * follows it (`renameConditionPaths`). A built designer is rewritten in place — its root's
   * committed `when`, and an unsaved one on the Rules tab too, renamed rather than overwritten —
   * with no entry of its own, so its history survives and holds nothing of the rename's. The
   * block's change and the trees' are one command of the form's history, which joins the
   * rename's own entry: one Undo of the rename points the conditions and
   * sources at the old id again, in the catalog and in every built tree, and Redo renames them
   * all again ({@link followFormStep}). Each layout rewritten is reported as a `"layouts"`
   * change. PDF bindings follow too: a component binding by id, a collection or path source by
   * the move of the data when the rename carries one (`dataPath`: `applicant.email` to
   * `applicant.mail`), else by its leading name.
   */
  public formRenamed(rename: { from: string; to: string; dataPath?: ValuePathMove }): void {
    this.followForm(rename.from, rename.to, rename.dataPath);
  }

  /**
   * The form's edit moved where answers are stored (a data key, a container's key or
   * `scopeData`; `BuilderChangeEvent.dataMoved`): every layout's path sources and
   * collection paths follow the moves, as they follow a rename's, and the block's change is a
   * step of the form's history that joins the edit's own. The moves of one edit are applied as
   * one map, so two keys swapped stay swapped. Conditions and component bindings address
   * components by id, so they stay.
   */
  public formDataMoved(moves: readonly ValuePathMove[]): void {
    const real = moves.filter((move) => move.from !== "" && move.from !== move.to);
    if (real.length > 0) {
      this.followForm("", "", real);
    }
  }

  /** {@link formRenamed} and {@link formDataMoved}: the ids `from` → `to` (or none), and where data went. */
  private followForm(from: string, to: string, dataPath: ValuePathMoves | undefined): void {
    // A move of data alone (no id changed) still moves the path sources.
    if ((from === "" || from === to) && dataPath === undefined) {
      return;
    }
    const blockBefore = this.model.configuration;
    const followed = renamePdfLayoutConditions(this.model.configuration, from, to, dataPath);
    const rewritten: string[] = [];
    for (const id of followed.renamed) {
      const layout = pdfLayoutsOf(followed.configuration).find((entry) => entry.id === id);
      if (!layout) {
        continue;
      }
      try {
        this.model.replaceQuietly(id, layout);
        rewritten.push(id);
      } catch (error) {
        this.options.onError?.("A layout's condition could not follow the rename", error);
      }
    }
    // Formulas that spell the old id but do not parse stay as written: say so, per layout.
    for (const note of followed.unparsed) {
      const tree = this.entries.get(note.layoutId)?.template !== undefined;
      if (!tree || (!note.where.startsWith("fields[") && !note.where.startsWith("areas["))) {
        this.reportRenameUnparsed(note.layoutId, note.where, note.formula, from, to);
      }
    }
    // With a form history to hold it, the trees' follow-up is the form's step, not the trees':
    // written with no entry, and carried by the step's Undo and Redo. A mode with no form
    // history (a host's own wiring) leaves it a step of each tree's, as nothing else could undo it.
    const form = this.options.form?.();
    const recorded = typeof (form as { recordStep?: unknown } | undefined)?.recordStep === "function";
    const treesChanged = this.followInTrees(from, to, dataPath, { unrecorded: recorded, report: true }).length > 0;
    // The block and the trees as one command of the form's history: heard with the rename, it
    // joins the rename's own entry, so an Undo of the rename takes the conditions and sources
    // back with it, in the catalog and in every built tree.
    if (recorded && (rewritten.length > 0 || treesChanged)) {
      recordFormStep(form, this.followFormStep(blockBefore, this.model.configuration, from, to, dataPath));
    }
    this.syncControls();
    for (const id of rewritten) {
      const layout = this.model.layouts.find((entry) => entry.id === id);
      if (layout) {
        this.options.onChange?.({ layout, pdf: this.model.configuration, reason: "layouts" });
      }
    }
  }

  /**
   * The rename `from` → `to` (and the moves of data, `dataPath`) followed into every built
   * tree: the committed conditions, bindings and sources in place, an unsaved one in a draft
   * renamed rather than overwritten; `unrecorded`, with no entry of the tree's ({@link
   * followFormStep} holds it). `report` says what a formula that does not parse kept. The
   * entries whose tree changed.
   */
  private followInTrees(from: string, to: string, dataPath: ValuePathMoves | undefined, options: { unrecorded: boolean; report: boolean }): LayoutEntry[] {
    const changed: LayoutEntry[] = [];
    this.syncingName = true;
    try {
      for (const entry of [...this.entries.values()]) {
        if (!entry.built || !(entry.designer ?? entry.template)) {
          continue;
        }
        // The committed condition in place, and the Rules tab's unsaved one renamed with it.
        let moved = followRenameInLayoutTree(entry.controller, from, to, dataPath, { unrecorded: options.unrecorded });
        // An open template designer's fields and areas hold their formulas in the tree too (it was made by the chunk, which is in).
        if (entry.template && this.chunk) {
          const followedTree = this.chunk.followRenameInTemplateTree(entry.controller, from, to, dataPath, { unrecorded: options.unrecorded });
          moved = followedTree.changed || moved;
          if (options.report) {
            for (const note of followedTree.unparsed) {
              this.reportRenameUnparsed(entry.id, note.nodeId, note.formula, from, to);
            }
          }
        }
        if (moved) {
          this.refreshReported(entry);
          changed.push(entry);
        }
      }
    } finally {
      this.syncingName = false;
    }
    return changed;
  }

  /**
   * A form rename's follow-up in the layouts (or a move of data's) as one command of the form's
   * history: the block's change ({@link blockCommand}) and every built tree's, made once both
   * are written, so its first run leaves things as they are. Undo and Redo follow the rename
   * the way the step goes in every tree built by then, with no entry of the tree's (the old id
   * back, or the new one again), as the form rename's journeys are followed: each tree writes
   * its layout into the catalog as it hears its edit, so the block's own Undo or Redo, carried
   * onto the catalog as it then stands, is left only the layouts no tree holds (one never
   * opened) and never rebuilds a designer, nor takes its history, over a change it already has.
   */
  private followFormStep(before: PdfConfiguration, after: PdfConfiguration, from: string, to: string, dataPath: ValuePathMoves | undefined): BuilderCommand {
    const block = this.blockCommand(before, after);
    let first = true;
    const follow = (back: boolean): LayoutEntry[] => this.followInTrees(back ? to : from, back ? from : to, back ? reversedMoves(dataPath) : dataPath, { unrecorded: true, report: false });
    const carry = (back: boolean, run: () => void): void => {
      const was = this.model.configuration;
      const moved = follow(back);
      const written = this.model.configuration;
      this.carryingFollow = true;
      try {
        run();
      } catch (error) {
        // A step that fails (a host's change listener throws) leaves the form as it stood: the trees and the catalog go back with it.
        follow(!back);
        this.model.apply(was);
        throw error;
      } finally {
        this.carryingFollow = false;
      }
      // The trees wrote every layout the step changed: the block's put, which says the change, had nothing left to do.
      const layout = moved.length > 0 && this.model.configuration === written ? this.model.layouts.find((entry) => entry.id === moved[0]!.id) : undefined;
      if (layout) {
        this.syncControls();
        this.options.onChange?.({ layout, pdf: this.model.configuration, reason: "layouts" });
      }
    };
    return {
      id: "PDF_LAYOUTS",
      execute: () => {
        if (first) {
          first = false;
          block.execute();
          return;
        }
        carry(false, () => block.execute());
      },
      undo: () => carry(true, () => block.undo())
    };
  }

  /** A formula a rename could not follow, said on the layout's status line and through `onError`. */
  private reportRenameUnparsed(layoutId: string, where: string, formula: string, from: string, to: string): void {
    const message = this.text("pdf.rename.unparsed", { layout: layoutId, where, from, to, formula });
    const entry = this.entries.get(layoutId);
    if (entry) {
      this.setStatus(entry, message, "error");
    }
    this.options.onError?.(message);
  }

  public openAdd(anchor?: HTMLElement, options: BuilderModeAddOptions = {}): void {
    // A second Add while the first waits for the chunk replaces it: the first flow ends here, its onEnd heard.
    const superseded = this.addPopover ? undefined : this.addOptions;
    this.addOptions = options;
    superseded?.onEnd?.(undefined);
    const open = (): void => this.addPopover?.open(anchor, { onDismiss: () => this.endAdd(undefined) });
    if (this.addPopover) {
      open();
      return;
    }
    // The popover is the chunk's: opened as soon as it is in; a chunk that cannot load ends the add flow.
    void this.ensureChunk().then(
      () => {
        if (this.addOptions === options) {
          open();
        }
      },
      () => this.endAdd(undefined)
    );
  }

  /** The add flow ended: with the layout made, or none. */
  private endAdd(made: string | undefined): void {
    const ended = this.addOptions?.onEnd;
    this.addOptions = undefined;
    ended?.(made);
  }

  /**
   * Maps every unmapped field of the populated form on the page whose name matches a form
   * component's id or label (a checkbox takes its first export value as the checked value).
   * Each mapping lands as its own edit, so a wrong guess undoes on its own. With `batch` (the
   * browser-assistant tools) they land as one edit, the way Create form fields
   * fills, so the assistant's suggestion is one step the person or Undo all takes back whole.
   */
  public suggestMappings(options: SuggestMappingsOptions = {}): number {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    const designer = entry?.template;
    const kit = this.chunk;
    if (!entry || !designer?.inspection || !kit) {
      return 0;
    }
    const run = options.around ?? ((step: () => void): void => step());
    // The form as it stands now: a field added, or one removed, since the designer was built.
    const formRoot = this.options.formRoot();
    const unmapped = this.unmappedTemplateFields(entry, designer, formRoot);
    const edits: Array<{ componentId: string; propertyPath: string; value: unknown }> = [];
    let count = 0;
    for (const mapping of kit.suggestFieldMappings(unmapped, kit.bindableComponents(formRoot, this.locale(), this.textSources()))) {
      const id = designer.widgetIdFor(mapping.pdfField);
      if (!id) {
        continue;
      }
      // A checkbox's source and checked value are one guess, so one edit.
      const pair = [
        { componentId: id, propertyPath: "source", value: { ...mapping.source } },
        ...(mapping.checkedValue !== undefined ? [{ componentId: id, propertyPath: "checkedValue", value: mapping.checkedValue }] : [])
      ];
      if (options.batch) {
        edits.push(...pair);
      } else {
        run(() => entry.controller.setProperties(pair));
      }
      count += 1;
    }
    if (edits.length > 0) {
      run(() => entry.controller.setProperties(edits));
    }
    // Said, not silent: the click gave no sign it had done anything, nor which
    // form fields the PDF leaves out. Counted from the tree as the suggestions left it.
    if (entry.noteEl) {
      const coverage = designer.coverageOf(entry.controller.snapshot(), formRoot);
      const textEl = entry.noteEl.querySelector<HTMLElement>("[data-template-summary-text]");
      const dismiss = entry.noteEl.querySelector<HTMLElement>("[data-template-summary-dismiss]");
      if (textEl && dismiss) {
        textEl.textContent = kit.mappingSummary(coverage, count, this.words());
        dismiss.textContent = this.text("shell.file.dismiss");
        entry.noteEl.hidden = false;
      }
    }
    return count;
  }

  /**
   * Builds a form field for every template field nothing fills and fills the field from it,
   * or from the form's own field of that name (`planTemplateFormFields` decides
   * what). The fields go into the form as one undoable insert on the Form tab; the mappings
   * land on this layout as one undoable edit. The form's unsaved edits hold it back: they are
   * on another tab, so the author is told rather than prompted.
   *
   * `around` (the browser-assistant tools) runs the two writes — the form's
   * insert and the layout's mappings — and nothing across the waits between them, so the
   * assistant's steps are told from an edit the person makes meanwhile. A refusal carries an
   * `errorCode` beside its words.
   */
  public async createFormFields(options: CreateFormFieldsOptions = {}): Promise<CreateFormFieldsResult> {
    const form = this.options.form?.();
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    const designer = entry?.template;
    const kit = this.chunk;
    const run = options.around ?? ((step: () => void): void => step());
    const refuse = (error: string, errorCode: NonNullable<CreateFormFieldsResult["errorCode"]>): CreateFormFieldsResult => {
      if (entry) {
        this.setStatus(entry, error, "error");
      }
      return { added: [], mapped: 0, matched: 0, skipped: [], error, errorCode };
    };
    if (!form || !entry || !designer?.inspection || !kit) {
      return { added: [], mapped: 0, matched: 0, skipped: [], error: this.text("pdf.fill.noForm"), errorCode: "no-form" };
    }
    // A PDF with no fields at all has nothing to build from (the bar hides the button then): not "every field is filled already".
    if (designer.inspection.fields.length === 0) {
      this.setStatus(entry, kit.noFillableFieldsText(this.words()));
      return { added: [], mapped: 0, matched: 0, skipped: [] };
    }
    const editing = form.selectedComponentId();
    if (editing !== undefined && form.hasPendingChanges(editing)) {
      return refuse(this.text("pdf.fill.formUnsaved", { id: editing }), "form-unsaved");
    }
    // This layout's own unsaved edits too: a source chosen and not saved is the author's
    // answer for that field, which the fill must neither overwrite nor build a field beside.
    if (entry.controller.hasPendingChanges()) {
      const open = entry.controller.selectedComponentId();
      return refuse(
        open !== undefined && entry.controller.hasPendingChanges(open) ? this.text("pdf.fill.layoutUnsavedNamed", { id: open }) : this.text("pdf.fill.layoutUnsaved"),
        "layout-unsaved"
      );
    }
    // A field filled from a component the form no longer has (an undo on the Form tab, say)
    // prints nothing: it is built for again like a field nothing fills.
    const unmapped = this.unmappedTemplateFields(entry, designer, form.snapshot());
    let plan: TemplateFormFieldsPlan | undefined;
    let held = false;
    const inserted = await new Promise<InsertComponentsResult>((resolve) => {
      let ran = false;
      run(() => {
        ran = form.requestInsertComponents(
          () => {
            const root = form.snapshot();
            plan = kit.planTemplateFormFields(
              unmapped,
              root,
              kit.bindableComponents(root, this.locale(), this.textSources()),
              {
                // What a journey's page-only fields hold: no field built takes it.
                takenIds: form.claimedIds(),
                hasType: (type) => form.hasComponentType(type),
                template: (type) => form.componentTemplate(type)
              },
              this.words()
            );
            return plan.entries;
          },
          // The author stays on the layout, watching its fields fill; the Form tab's selection stays put.
          { select: "none", onResult: resolve }
        );
      });
      if (!ran) {
        // Held for a prompt the Form tab would show: let it go, so nothing lands unmapped later.
        held = true;
        form.answerUnsavedChangesPrompt("stay");
        resolve({ ok: false, ids: [], error: this.text("pdf.fill.holding") });
      }
    });
    if (!inserted.ok || !plan) {
      return refuse(this.text("pdf.fill.refused", { reason: inserted.error ?? this.text("pdf.fill.refusedDefault") }), held ? "holding" : "refused");
    }
    // The pickers a widget is filled from list the fields just added before any names one.
    await this.refreshTemplateComponents(entry, form.snapshot());
    const current = entry.template ?? designer;
    const tree = entry.controller.snapshot();
    const edits: Array<{ componentId: string; propertyPath: string; value: unknown }> = [];
    let filled = 0;
    for (const mapping of plan.mappings) {
      const id = current.widgetIdFor(mapping.pdfField);
      if (!id || !containsNode(tree, id)) {
        continue;
      }
      edits.push({ componentId: id, propertyPath: "source", value: { ...mapping.source } });
      if (mapping.checkedValue !== undefined) {
        edits.push({ componentId: id, propertyPath: "checkedValue", value: mapping.checkedValue });
      }
      filled += 1;
    }
    run(() => entry.controller.setProperties(edits));
    const result: CreateFormFieldsResult = { added: inserted.ids, mapped: filled, matched: plan.matched, skipped: plan.skipped };
    this.setStatus(entry, createFieldsSummary(result, kit.pdfFieldOwnName, this.words()));
    return result;
  }

  public async previewPdf(): Promise<void> {
    // The answers tried in Try it fill the preview; the host's own runtime when none are.
    const tried = this.options.triedRuntime?.();
    this.previewOrigin = "bar";
    await this.showPreview({ runtime: tried, byAnswers: false, typed: tried ? this.options.triedCount?.() : 0 });
  }

  public async previewReport(options: PdfPreviewReportOptions = {}): Promise<PdfPreviewReport | { error: string; busy?: true }> {
    if (this.previewBusy) {
      return { error: "A preview is being made already.", busy: true };
    }
    // A preview already open (Try it's, say) is refilled: closing it still goes back where the person opened it.
    if (!(this.previewDialogEl.open || this.previewDialogEl.hasAttribute("open"))) {
      this.previewOrigin = "bar";
    }
    const root = options.root ?? this.context?.root;
    return this.showPreview({
      runtime: options.runtime,
      // No layout named: the answers choose, as a download that names none.
      byAnswers: options.layoutId === undefined,
      ...(options.layoutId !== undefined ? { layoutId: options.layoutId } : {}),
      ...(root ? { root } : {}),
      quietFocus: true
    });
  }

  /**
   * Renders and shows the preview dialog, and says what it rendered; one at a time, shared by the
   * bar's button, Try it's Preview PDF and the browser-assistant tools' (`previewReport`).
   * `quietFocus`: while the person's focus is elsewhere, or the shell is inert, the dialog opens
   * without taking it (`opensQuietly`).
   */
  private async showPreview(request: {
    runtime: RenderableRuntime | undefined;
    byAnswers: boolean;
    layoutId?: string | undefined;
    root?: ShadowRoot | undefined;
    typed?: number | undefined;
    quietFocus?: boolean | undefined;
  }): Promise<PdfPreviewReport | { error: string; busy?: true }> {
    if (this.previewBusy) {
      return { error: "A preview is being made already.", busy: true };
    }
    const { runtime, byAnswers, layoutId, root, typed } = request;
    // From another workspace this mode is not on the page and its overlays are not mounted: the
    // dialog (and the styles it needs) go into the shell's root the caller names, and stay there
    // closed until the mode is activated, when the shell moves them into place.
    const dialogEl = this.overlays[0];
    if (root && dialogEl && !dialogEl.isConnected) {
      const marker = `${this.id}-preview`;
      if (!root.querySelector(`style[data-mode-style="${marker}"]`)) {
        const style = document.createElement("style");
        style.setAttribute("data-mode-style", marker);
        style.textContent = PDF_BUILDER_MODE_STYLES;
        root.append(style);
      }
      root.append(dialogEl);
    }
    if (request.quietFocus && !this.previewDialogEl.isConnected) {
      // A preview the person would not see is no preview: the caller is told, nothing renders.
      return { error: "The preview dialog is not on the page." };
    }
    this.previewBusy = true;
    this.syncControls();
    try {
      // The dialog is the chunk's: a Preview before any layout opened brings it in first.
      await this.ensureChunk();
      const result = await this.renderPdf({ runtime, byAnswers, ...(layoutId !== undefined ? { layoutId } : {}) });
      const layout = byAnswers || layoutId !== undefined ? this.model.layouts.find((candidate) => candidate.id === result.layoutId) : this.currentLayout();
      const show = (): void =>
        this.previewDialog?.show(result, {
          layoutName: layout ? this.layoutName(layout) : undefined,
          paper: layout?.kind === "generated" ? paperName(layout, this.words()) : undefined,
          // Typed answers only: the host's sample values and calculated ones are not the author's.
          answers: typed ?? (runtime ? typedAnswers(runtime) : 0),
          // A layout named that is not the open one is said by its name, as one the answers chose.
          byAnswers: byAnswers || (layoutId !== undefined && layoutId !== this.model.selected()?.id)
        });
      if (this.opensQuietly(request.quietFocus)) {
        this.showWithoutFocus(show);
      } else {
        this.showModally(show);
      }
      return previewReportOf(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.previewDialog) {
        if (this.opensQuietly(request.quietFocus)) {
          this.showWithoutFocus(() => this.previewDialog?.showError(message));
        } else {
          this.showModally(() => this.previewDialog?.showError(message));
        }
      } else {
        // The dialog is the chunk's and the chunk is not in: said where the author is looking, with Retry on the canvas.
        this.chunkFailure = error ?? new Error(message);
        this.options.onError?.(this.text("shell.load.failed.layouts"), error);
        if (this.active) {
          this.applyView();
        }
      }
      return { error: message };
    } finally {
      this.previewBusy = false;
      this.syncControls();
    }
  }

  /**
   * Whether an assistant's preview (`quietFocus`) opens without focus: while the
   * person's focus is elsewhere, and while the shell is inert (an assistant session) — a modal
   * dialog there would make the whole page inert under it, the session banner's Stop included,
   * whoever had focus. The person's own previews always open modal.
   */
  private opensQuietly(quietFocus: boolean | undefined): boolean {
    return quietFocus === true && (focusIsElsewhere(this.previewDialogEl) || underInert(this.previewDialogEl));
  }

  /**
   * The dialog opened as the person's Preview opens it: modal, taking focus. One the assistant
   * opened quietly is closed first, so it opens modal now.
   */
  private showModally(show: () => void): void {
    const dialogEl = this.previewDialogEl;
    if (dialogEl.hasAttribute("data-preview-quiet")) {
      dialogEl.removeAttribute("data-preview-quiet");
      if (dialogEl.open || dialogEl.hasAttribute("open")) {
        if (typeof dialogEl.close === "function") {
          dialogEl.close();
        } else {
          dialogEl.removeAttribute("open");
        }
      }
    }
    show();
  }

  /**
   * The dialog opened for the browser-assistant tools while the person's focus is elsewhere
   *: not modal, so nothing on the page goes inert under the person,
   * placed where the modal one sits (`data-preview-quiet`), and focus left where it was. It is
   * opened by its `open` attribute, never `show()`: a browser's `show()` runs the dialog focusing
   * steps, and focus taken and given back still blurs the person's control (a rename box or an
   * inspector box commits on that blur, a composition ends). The chunk's `openDialog` then sees
   * it open and leaves it so. A dialog already open stays as it is.
   */
  private showWithoutFocus(show: () => void): void {
    const dialogEl = this.previewDialogEl;
    const before = deepActiveElement();
    if (!(dialogEl.open || dialogEl.hasAttribute("open"))) {
      dialogEl.setAttribute("data-preview-quiet", "");
      dialogEl.setAttribute("open", "");
      // Not modal, yet over the builder's box as the modal one is.
      followModalBox(dialogEl);
    }
    // Open already: the chunk's show() fills it and leaves it open as it is.
    show();
    // Nothing above moves focus; should anything do so, it goes back.
    const after = deepActiveElement();
    if (after === before) {
      return;
    }
    if (before instanceof HTMLElement && before !== document.body && before.isConnected) {
      before.focus({ preventScroll: true });
    } else if (after instanceof HTMLElement && dialogEl.contains(after)) {
      after.blur();
    }
  }

  /**
   * The PDF of the layout asked for, else of the layout on the page; with no layout at all,
   * of the one a host would print: the layout the engine derives from the form.
   */
  public async renderPdf(options: { layoutId?: string | undefined; runtime?: RenderableRuntime | undefined; byAnswers?: boolean | undefined } = {}): Promise<RenderFormPdfResult> {
    // By the answers (Try it from another workspace) names no layout, so renderFormPdf
    // chooses: the first whose condition holds, else the declared default.
    const layout = options.layoutId !== undefined ? this.model.require(options.layoutId) : options.byAnswers ? undefined : this.currentLayout();
    if (!layout && !options.byAnswers && this.model.layouts.length > 0) {
      throw new Error("The designer has no layout yet");
    }
    const support = await this.ensureSupport();
    return renderFormPdf(
      options.runtime ? this.withLayouts(options.runtime) : this.options.runtime(),
      {
        provider: support.provider,
        fonts: support.fonts,
        images: support.images,
        theme: support.theme,
        binding: support.binding,
        themes: support.themes,
        templates: this.templateResolver()
      },
      // A designer preview prints whatever the author has typed so far.
      { layout, formulaErrors: "warn" }
    );
  }

  // --- internals ---------------------------------------------------------------

  private seed(): PdfModeSeed {
    return { pdf: this.options.pdf, root: this.options.formRoot(), title: this.title() };
  }

  private title(): string | undefined {
    return this.options.title?.() ?? readTitle(this.options.formRoot());
  }

  private locale(): string {
    return this.options.locale?.() ?? "en";
  }

  /** The definition's translations as the form holds them now: the option, else the form's controller. */
  private formMap(): FormTranslations | undefined {
    return this.options.formTranslations?.() ?? formTranslationsOf(this.options.form?.());
  }

  /** What a layout's name and a component's label are worded from: the definition's map and the host's catalog. */
  private textSources(): TextSources {
    return { translations: this.formMap(), catalog: this.options.translations?.() };
  }

  /** `map` without what lives under `prefix`, the entries held against the edit being taken back. */
  private pruneHeld(map: FormTranslations, prefix: TranslationPrefix): FormTranslations {
    const path = prefix.path ?? [];
    const held = listTranslations(map).filter(
      (item) => item.address.kind === prefix.kind && item.address.owner === prefix.owner && path.every((segment, at) => item.address.path[at] === segment)
    );
    if (held.length > 0) {
      const key = JSON.stringify([prefix.kind, prefix.owner ?? null, ...path]);
      this.pruned.delete(key);
      this.pruned.set(key, held);
      // An Undo that never comes must not grow the session without end: the oldest are let go.
      if (this.pruned.size > PRUNED_KEPT) {
        this.pruned.delete(this.pruned.keys().next().value as string);
      }
    }
    return pruneTranslations(map, prefix);
  }

  /**
   * The texts of `layouts` (key of the address to its default) that are not in `skip`: the ones
   * a layout has now and lacked before, which is how an address "returns".
   */
  private defaultsOf(layouts: readonly PdfLayoutDocument[], skip?: ReadonlyMap<string, string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const text of pdfOutsideTexts({ layouts: [...layouts] } as PdfConfiguration)) {
      const key = JSON.stringify([text.address.kind, text.address.owner ?? null, ...text.address.path]);
      if (!skip?.has(key)) {
        out.set(key, text.default);
      }
    }
    return out;
  }

  /**
   * Writes again what was held for an address in `returning`, exactly as it went (its `source`
   * too: a source-changed entry comes back source-changed). An address that has an entry already
   * is left as it is.
   */
  private restoreHeld(map: FormTranslations, returning: ReadonlyMap<string, string>): FormTranslations {
    if (this.pruned.size === 0 || returning.size === 0) {
      return map;
    }
    let next = map;
    for (const [key, items] of [...this.pruned]) {
      const back = items.filter((item) => returning.has(JSON.stringify([item.address.kind, item.address.owner ?? null, ...item.address.path])));
      if (back.length === 0) {
        continue;
      }
      for (const item of back) {
        if (readTranslation(next, item.locale, item.address) === undefined) {
          next = writeTranslationEntry(next, item.locale, item.address, item.entry);
        }
      }
      const rest = items.filter((item) => !back.includes(item));
      if (rest.length === 0) {
        this.pruned.delete(key);
      } else {
        this.pruned.set(key, rest);
      }
    }
    return next;
  }

  /**
   * The layouts' block as a step of the form's history, composed with the
   * map's command by `BuilderController.rewriteTranslations` (or alone, `formSteps`): a catalog
   * action, or a node, mapping or area deleted, is one Undo with its wording. The change is
   * already applied when this is made, so the first run does nothing; Undo and Redo put the
   * block back as the step left it, carrying just the step's change onto the block as it stands
   * then. The designer's own Undo still restores a node and `restoreHeld` writes the wording
   * again only where the map lacks it, so the two never double-restore.
   */
  private blockCommand(before: PdfConfiguration, after: PdfConfiguration): BuilderCommand {
    return appliedStep("PDF_LAYOUTS", before, after, () => this.model.configuration, carryPdfBlock, (next) => {
      const held = new Map(pdfLayoutsOf(this.model.configuration).map((layout) => [layout.id, JSON.stringify(layout)]));
      const subject =
        pdfLayoutsOf(next).find((layout) => held.get(layout.id) !== JSON.stringify(layout)) ??
        this.model.layouts.find((layout) => !pdfLayoutsOf(next).some((kept) => kept.id === layout.id)) ??
        pdfLayoutsOf(next)[0];
      // A layout on the page that the step takes away leaves the page where a removal leaves it: on the first left.
      const shown = this.model.selected()?.id;
      const select = pdfLayoutsOf(next).some((layout) => layout.id === shown) ? undefined : pdfLayoutsOf(next)[0]?.id;
      if (subject) {
        this.applyConfiguration(structuredClone(next), subject, "layouts", select);
      }
    });
  }

  /** The builder's words: its locale and the host's builder texts, read live. */
  private words(): BuilderTextOptions {
    const catalog = this.textCatalog?.();
    return { locale: this.locale(), ...(catalog ? { catalog } : {}) };
  }

  private text(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return builderText(key, params, this.words());
  }

  /** The designer's chunk, loaded on first need and shared; a failed load is reported once and tried again next time. */
  private async ensureChunk(): Promise<PdfDesignerModule> {
    if (this.chunk) {
      return this.chunk;
    }
    let module: PdfDesignerModule;
    try {
      module = await loadPdfDesigner();
    } catch (error) {
      this.options.onError?.("The PDF designer could not load", error);
      throw error;
    }
    this.chunk = module;
    this.chunkFailure = undefined;
    this.mountPanels(module);
    return module;
  }

  /** The Preview dialog and the Add popover over the elements the shell mounted, made once the chunk that draws them is in. */
  private mountPanels(module: PdfDesignerModule): void {
    if (this.previewDialog) {
      return;
    }
    const options = this.options;
    this.previewDialog = module.createPreviewDialog(this.previewDialogEl, {
      locale: () => this.locale(),
      textCatalog: () => this.textCatalog?.(),
      onClose: () => this.restoreFocus(),
      ...(options.clearTried ? { clearAnswers: () => options.clearTried!() } : {})
    });
    this.addPopover = module.createAddPopover(this.addEl, {
      locale: () => this.locale(),
      textCatalog: () => this.textCatalog?.(),
      templates: () => this.hostTemplates(),
      canPopulate: () => this.canExecute(),
      // An upload that would make the form unloadable is refused before it is named.
      templateProblem: (source) => {
        const layout = this.templateLayoutFor(source, "");
        return this.heavyTemplateProblem(addPdfLayout(this.model.configuration, layout), layout);
      },
      // From an overview no layout is on the page, so there is none to copy.
      canCopy: () => !this.addOptions?.fromOverview && this.model.selected() !== undefined,
      // What a copy would be called, offered in the name box.
      copyName: () => {
        const current = this.model.selected();
        return current ? this.text("pdf.copyName", { name: nameText(current.name) || current.id }) : undefined;
      },
      // The name is the author's (the add popover asked for it).
      onCustom: (from, name) => {
        let made: string | undefined;
        try {
          if (from === "copy") {
            const current = this.model.selected();
            if (current) {
              made = this.duplicateLayout(current.id, { select: true, name }).id;
            }
          } else {
            made = this.newLayout({ name, from }).id;
          }
        } catch (error) {
          this.options.onError?.("The layout could not be added", error);
        }
        this.endAdd(made);
      },
      onTemplate: (source, name) => {
        let made: string | undefined;
        try {
          made = this.addTemplateLayout(source, name).id;
        } catch (error) {
          this.options.onError?.("The layout could not be added", error);
        }
        this.endAdd(made);
      }
    });
  }

  private hostTemplates(): Promise<readonly PdfTemplateOption[]> {
    const resolver = this.options.templates?.();
    const list = resolver?.list;
    return list ? list.call(resolver).catch(() => []) : Promise.resolve([]);
  }

  /** The ICC profiles the host offers as output conditions; a list that fails to load is an empty one. */
  private hostProfiles(): Promise<readonly PdfProfileOption[]> {
    const resolver = this.options.templates?.();
    const list = resolver?.listProfiles;
    return list ? list.call(resolver).catch(() => []) : Promise.resolve([]);
  }

  private documentList(): BuilderDocument[] {
    const locale = this.locale();
    const sources = this.textSources();
    const defaultId = this.model.defaultId;
    return this.model.layouts.map((layout) => ({
      id: layout.id,
      label: pdfLayoutLabel(layout, locale, sources),
      isDefault: layout.id === defaultId,
      // Tried by the answers, in the list's order; drawn beside the name, not in it.
      ...(readPdfLayoutCondition(layout) !== undefined ? { badge: this.text("pdf.badge.conditional") } : {})
    }));
  }

  private notifyDocuments(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** The form a layout's condition reads, as the builder names its components. */
  private conditionContext(): PdfLayoutConditionContext {
    const textCatalog = this.textCatalog?.();
    return { formRoot: this.options.formRoot(), locale: this.locale(), translations: this.formMap(), catalog: this.options.translations?.(), ...(textCatalog ? { textCatalog } : {}) };
  }

  /**
   * The catalog as the author sees it: the layout on the page with its condition as the Rules
   * tab has it, an unsaved one included, so the words and findings follow the typing.
   */
  private liveConfiguration(): PdfConfiguration {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    if (!selected || !entry?.built || !(entry.designer ?? entry.template)) {
      return this.model.configuration;
    }
    const root = entry.controller.editedNode(entry.controller.rootId());
    return root ? withPdfLayoutCondition(this.model.configuration, selected.id, readConfig(root).when) : this.model.configuration;
  }

  /**
   * The advisory notes on a layout's root: its condition's findings, with its draft
   * laid over the catalog, and the form-wide one (no default declared), under the Rules tab's
   * condition — and so above the Properties tab's sections too. They never hold a Save.
   */
  private rootNotes(entry: LayoutEntry, edited: ComponentNode): BuilderNote[] {
    const live = withPdfLayoutCondition(this.model.configuration, entry.id, readConfig(edited).when);
    return pdfLayoutConditionFindings(this.conditionContext(), live)
      .filter((finding) => finding.layoutId === undefined || finding.layoutId === entry.id)
      .map((finding) => ({ target: "rules:when", message: finding.message, severity: "warning" as const }));
  }

  /** The Form panel's PDF group: with several layouts, which one a download prints, in words. */
  private orderRows(): BuilderFormSettingReadOnlyRow[] {
    if (this.model.layouts.length < 2) {
      return [];
    }
    const note = (): string => {
      const context = this.conditionContext();
      const configuration = this.model.configuration;
      // What would surprise the author about the order: a layout that can never win, no default.
      const surprises = pdfLayoutConditionFindings(context, configuration)
        .filter((finding) => finding.code === "pdf-layout.condition.shadowed" || finding.code === "pdf-layout.no-default")
        .map((finding) => finding.message);
      return [pdfLayoutOrderInWords(context, configuration), ...surprises].join(" ");
    };
    return [
      {
        id: "pdf.order",
        label: this.text("pdf.order.label"),
        // Read on every paint, so a form label edited since reads as it now stands.
        get note() {
          return note();
        },
        open: { label: this.text("pdf.order.open") }
      }
    ];
  }

  /** What the conditions, the order, the names and the default are: a change repaints the words that say them. */
  private conditionsSignature(): string {
    const configuration = this.model.configuration;
    return JSON.stringify([
      pdfLayoutsOf(configuration).map((layout) => [
        layout.id,
        layout.name ?? null,
        layout.when ?? null,
        layout.kind === "template" ? layout.template.storage : null
      ]),
      configuration.defaultLayoutId ?? null
    ]);
  }

  /** The layout on the page as it stands: as designed so far (committed edits; drafts wait for Save). */
  private currentLayout(): PdfLayoutDocument | undefined {
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    if (selected?.kind === "generated" && entry?.designer && entry.designer.layout.id === selected.id) {
      return entry.designer.layoutFrom(entry.controller.snapshot());
    }
    if (selected?.kind === "template" && entry?.template && entry.template.layout.id === selected.id) {
      return entry.template.layoutFrom(entry.controller.snapshot());
    }
    return selected;
  }

  /** Commits an edited configuration: the page follows `select`, the chrome is redrawn, the change reported. */
  private applyConfiguration(next: PdfConfiguration, layout: PdfLayoutDocument, reason: PdfBuilderModeChangeDetail["reason"], select?: string): void {
    const conditionsBefore = this.conditionsSignature();
    const previous = this.model.configuration;
    const result = this.model.apply(next, select);
    const entry = result.after ? this.entries.get(result.after.id) : undefined;
    this.followCatalog(previous, result.after?.id);
    if (result.renamed && result.after && entry?.built && entry.kind === result.after.kind) {
      this.pushName(entry, result.after.name);
    } else if (result.rebuild && entry && !select && JSON.stringify(pdfLayoutsOf(previous).find((layout) => layout.id === entry.id)) !== JSON.stringify(result.after)) {
      // The layout on the page changed underneath its designer (a host replaced it): start over.
      // A page that only fell back to a layout as it was (a copy on the page taken back) keeps
      // that layout's designer and its history.
      entry.built = undefined;
    } else if (entry?.built && !result.rebuild && result.after?.id === result.before?.id && conditionsBefore !== this.conditionsSignature()) {
      // A catalog action says nothing to the open layout's controller, yet its Rules tab says
      // where it stands in the order and what the others' conditions mean for it:
      // a repaint reads those words again.
      entry.controller.repaintPreview();
    }
    this.syncControls();
    this.options.onChange?.({ layout, pdf: this.model.configuration, reason, ...(select !== undefined ? { select } : {}) });
    if (select !== undefined && result.after && result.after.id === select && result.before?.id !== select) {
      this.options.onSelect?.({ layoutId: select, layout: result.after });
    }
    // A rename's follow-up carried by an Undo or a Redo (`followFormStep`) has brought every
    // built tree along already: the page is only brought up to date when the layout on it must
    // be built again, so a designer the form's step left as it stood keeps its history.
    if (result.rebuild || (result.after !== result.before && !this.carryingFollow)) {
      void this.ensureFresh().then(() => this.applyView());
    }
  }

  /**
   * The designers off the page follow a catalog change to their layouts, so the next edit on
   * one cannot write the layout it was built over back over the change (a host's
   * `renameLayout` or `replaceLayout` of a layout visited earlier): a new name is pushed into
   * the open tree, as on the page; anything else rebuilds it from the catalog on its next visit.
   * A designer whose layout is gone — removed, or now under another id — is disposed, so a
   * layout given that id later is built afresh. The page's own designer is the caller's.
   */
  private followCatalog(previous: PdfConfiguration, onPage: string | undefined): void {
    const before = new Map(pdfLayoutsOf(previous).map((layout) => [layout.id, layout]));
    const now = new Map(this.model.layouts.map((layout) => [layout.id, layout]));
    const sansName = (layout: PdfLayoutDocument): string => JSON.stringify({ ...layout, name: undefined });
    for (const [id, entry] of [...this.entries]) {
      const layout = now.get(id);
      if (!layout) {
        this.disposeEntry(entry);
        this.entries.delete(id);
        continue;
      }
      const was = before.get(id);
      if (id === onPage || !entry.built || !was || JSON.stringify(was) === JSON.stringify(layout)) {
        continue;
      }
      if (entry.kind === layout.kind && was.kind === layout.kind && sansName(was) === sansName(layout)) {
        this.pushName(entry, layout.name);
      } else {
        // Whatever was building over the old layout is dropped with it.
        entry.token += 1;
        entry.built = undefined;
      }
    }
  }

  /**
   * A layout's new name into its built tree's document root (the inspector's "Layout name"),
   * without an entry of the tree's: the catalog's change is a step of the
   * form's history (a rename, Make default, the form's Undo or Redo putting a name back), so the
   * tree's own Undo never takes it back on its own nor twice.
   */
  private pushName(entry: LayoutEntry, name: string | undefined): void {
    const controller = entry.controller;
    this.syncingName = true;
    try {
      controller.setPropertyUnrecorded(controller.rootId(), "name", name ?? "");
      this.refreshReported(entry);
    } finally {
      this.syncingName = false;
    }
  }

  // --- the entries -------------------------------------------------------------

  private entryFor(id: string): LayoutEntry {
    let entry = this.entries.get(id);
    if (entry) {
      return entry;
    }
    const controller = new BuilderController();
    // The root's condition is a formula written as a property, so Save holds it back unparsed.
    controller.setOptions({ ruleTargets: ["when"] });
    const created: LayoutEntry = {
      id,
      controller,
      token: 0,
      builds: 0,
      // Only the root carries the condition; every other node has nothing to say.
      notes: (edited, tree, componentId) => (componentId === tree.id ? this.rootNotes(created, edited) : []),
      unsubscribe: () => undefined
    };
    const offChange = controller.on("change", (event) => this.onEntryChange(created, event.reason, event.root, event.historyStep));
    const offSelection = controller.on("selection", () => this.syncViewer(created));
    created.unsubscribe = () => {
      offChange();
      offSelection();
    };
    entry = created;
    this.entries.set(id, entry);
    return entry;
  }

  /** The layout as the tree stands, as the baseline the next change is measured against. */
  private refreshReported(entry: LayoutEntry): void {
    const designer = entry.designer ?? entry.template;
    entry.reportedJson = designer ? JSON.stringify(designer.layoutFrom(entry.controller.snapshot())) : undefined;
  }

  private disposeEntry(entry: LayoutEntry): void {
    entry.token += 1;
    entry.unsubscribe();
    entry.viewer?.dispose();
    entry.surface?.remove();
    if (this.context && this.model.selected()?.id === entry.id) {
      this.context.showCanvasSurface(undefined);
    }
  }

  /** An edit on one layout's tree: the catalog follows, the viewer follows, the host hears. */
  private onEntryChange(entry: LayoutEntry, reason: BuilderChangeReason, root: ComponentNode, historyStep?: "undo" | "redo"): void {
    // `init` is the designer's own seeding; `preview` and `select` leave the layout as it was.
    if (reason === "init" || reason === "preview" || reason === "select") {
      if (entry.kind === "template") {
        this.syncViewer(entry);
      }
      return;
    }
    // The Suggest mappings note counts and names fields as the tree stood when it was written; any
    // later edit (a hand mapping, an undo, a form change) can make it wrong, so it goes.
    if (entry.noteEl && !entry.noteEl.hidden) {
      entry.noteEl.hidden = true;
    }
    const designer = entry.designer ?? entry.template;
    if (!designer || !this.model.layouts.some((layout) => layout.id === entry.id)) {
      return;
    }
    const next = designer.layoutFrom(root);
    const nextJson = JSON.stringify(next);
    if (entry.kind === "template") {
      // The viewer follows drafts too: an unsaved rectangle or mapping shows on the pages.
      this.syncViewer(entry);
    }
    if (nextJson === entry.reportedJson) {
      // A draft keystroke, or an edit that left the layout as it was: nothing to keep or report.
      entry.reportedJson = nextJson;
      return;
    }
    const previous = this.model.layouts.find((layout) => layout.id === entry.id);
    const blockBefore = this.model.configuration;
    try {
      this.model.replaceQuietly(entry.id, next);
    } catch (error) {
      this.options.onError?.("A layout edit could not be kept", error);
      return;
    }
    // A node, mapping or area the edit took out takes its translations with it; one whose id
    // changed takes them along. The translations are the form's and its history is
    // not the layout's, so what is pruned is held (`pruned`) and written again when the designer's
    // Undo brings the address back: the texts the layout has now that it lacked before.
    if (previous) {
      // The follow-up is the tree step's own (`formSteps.followUp`): the tree's Undo or Redo of
      // an edit whose follow-up is the form's next entry that way steps that entry, which puts
      // the wording and the block back as they were (the block already reads as the tree, so
      // its part writes nothing), and writes no entry over a catalog step held under it.
      this.formSteps.followUp(entry.controller, historyStep, () => {
        const { prune, move } = layoutTextChanges(previous, next);
        const returning = this.defaultsOf([next], this.defaultsOf([previous]));
        if (prune.length > 0 || move.length > 0 || (this.pruned.size > 0 && returning.size > 0)) {
          // The layout and its wording are one step of the form's history, as the designer's own
          // Undo restores the layout too: neither double-restores (`restoreHeld` writes only where
          // the map lacks the entry, and the block is carried, not replaced).
          rewriteFormTranslations(
            this.options.form?.(),
            (map) =>
              this.restoreHeld(
                move.reduce((moved, step) => moveTranslations(moved, step.from, step.to), prune.reduce((pruned, prefix) => this.pruneHeld(pruned, prefix), map)),
                returning
              ),
            this.blockCommand(blockBefore, this.model.configuration),
            move.flatMap((step) => {
              const [level, from] = step.from.path ?? [];
              const to = step.to.path?.[1];
              return step.from.owner !== undefined && level !== undefined && from !== undefined && to !== undefined ? [{ kind: "pdf" as const, owner: step.from.owner, within: level, from, to }] : [];
            })
          );
        }
      });
    }
    entry.reportedJson = nextJson;
    this.syncControls();
    if (entry.kind === "template" && entry.template && next.kind === "template" && !sameTemplate(next.template, entry.template.layout.template)) {
      // Another PDF: its fields are read and the tree starts over on them, the mappings
      // carried by name.
      entry.built = undefined;
      void this.ensureFresh().then(() => this.applyView());
    }
    if (!this.syncingName) {
      this.options.onChange?.({ layout: next, pdf: this.model.configuration, reason });
    }
  }

  /**
   * Brings the layout on the page up to date with the catalog and the form: rebuilt when the
   * page moved to a layout whose designer is not built, or the form changed underneath a
   * custom layout, or a populated form's PDF changed; refreshed in place when only the sample
   * answers or the form's components did; left alone otherwise — so history, drafts and
   * selection survive a round trip through another tab.
   */
  private async ensureFresh(): Promise<void> {
    if (!this.model.selected()) {
      return;
    }
    if (!this.chunk) {
      // A layout is to be designed: the designers are the chunk's. A failed load was reported
      // (`ensureChunk`) and is tried again on the next visit.
      try {
        await this.ensureChunk();
      } catch (error) {
        this.chunkFailure = error ?? new Error("The PDF designer could not load");
        return;
      }
    }
    // Read after the wait: the page may have moved to another layout meanwhile.
    const selected = this.model.selected();
    if (!selected) {
      return;
    }
    const entry = this.entryFor(selected.id);
    const rootJson = JSON.stringify(this.options.formRoot());
    const values = this.options.values?.() ?? {};
    const valuesJson = JSON.stringify(values);
    if (selected.kind === "generated") {
      const built = entry.built;
      if (!built || entry.kind !== "generated" || !entry.designer || built.rootJson !== rootJson) {
        await this.rebuildGenerated(entry, selected, rootJson, valuesJson);
        return;
      }
      this.syncLocalization(entry);
      if (built.valuesJson !== valuesJson) {
        await entry.designer.refresh(values);
        built.valuesJson = valuesJson;
        // A bare "preview" change leaves the canvas's renderer as it was when the tree is the
        // same (it repaints only on a new tree, theme or renderer set), so the sheet kept the old
        // field previews in a real browser. A fresh renderer set — the same definitions, their
        // previews now over the new answers — repaints it, with the tree, history and selection
        // untouched.
        entry.controller.setComponentDefinitions(entry.designer.builderOptions.componentDefinitions ?? [], entry.designer.builderOptions.componentTypes);
      }
      return;
    }
    const built = entry.built;
    const waiting = entry.template !== undefined && entry.template.inspection === undefined && this.canExecute();
    if (!built || entry.kind !== "template" || !entry.template || !built.template || !sameTemplate(built.template, selected.template) || waiting) {
      await this.rebuildTemplate(entry, selected, rootJson);
      return;
    }
    this.syncLocalization(entry);
    if (built.rootJson !== rootJson) {
      await this.refreshTemplateComponents(entry, this.options.formRoot());
    }
  }

  /** The template's fields nothing fills on this layout: unmapped, or filled from a component `formRoot` does not hold. */
  private unmappedTemplateFields(entry: LayoutEntry, designer: PdfTemplateDesigner, formRoot: ComponentNode): PdfTemplateFieldInfo[] {
    const tree = entry.controller.snapshot();
    const mapped = designer.mappedFieldsOf(tree);
    const unresolved = designer.unresolvedFieldsOf(tree, collectNodeIds(formRoot));
    return (designer.inspection?.fields ?? []).filter((field) => !mapped.has(field.name) || unresolved.has(field.name));
  }

  /**
   * The form changed: the components a widget or an area of a populated form may be filled
   * from did too. The definitions are refreshed under the tree, which stays as it is.
   */
  private async refreshTemplateComponents(entry: LayoutEntry, root: ComponentNode): Promise<void> {
    const template = entry.template;
    if (!template) {
      return;
    }
    const hostTemplates = await this.hostTemplates();
    const profiles = await this.hostProfiles();
    if (entry.template !== template) {
      // Rebuilt meanwhile (another PDF): that designer is already over the form as it is.
      return;
    }
    const fresh = (await this.ensureChunk()).createPdfTemplateDesigner({
      layout: template.layoutFrom(entry.controller.snapshot()),
      inspection: template.inspection,
      formRoot: root,
      locale: this.locale(),
      translations: this.formMap(),
      translationCatalog: this.options.translations?.(),
      textCatalog: this.textCatalog?.(),
      hostTemplates,
      outputIntentProfiles: profiles,
      // The widgets keep the ids the tree gave them.
      tree: entry.controller.snapshot()
    });
    // Swapped under the tree, not rebuilt: its history, open drafts and selection stay.
    entry.controller.setComponentDefinitions(fresh.builderOptions.componentDefinitions ?? [], fresh.builderOptions.componentTypes);
    // Suggest mappings, the notes and the pickers read the form through the designer.
    entry.template = fresh;
    if (entry.built) {
      entry.built.rootJson = JSON.stringify(root);
    }
    // The answers an option list offers moved with the form: the layout's stale-map line follows.
    this.syncViewer(entry);
  }

  /**
   * The form's locales onto the layout's controller, when they moved since the designer was
   * built (a locale added on the Form side, say). Not a layout edit: the change is kept off
   * the mode's own change reporting, and the panels repaint as for a preview.
   */
  private syncLocalization(entry: LayoutEntry): void {
    const before = JSON.stringify(entry.controller.localization() ?? null);
    entry.controller.setLocalization(this.options.localization?.(), { silent: true });
    if (JSON.stringify(entry.controller.localization() ?? null) !== before) {
      entry.controller.repaintPreview();
    }
  }

  private async rebuildGenerated(entry: LayoutEntry, layout: PdfLayoutDocument & { kind: "generated" }, rootJson: string, valuesJson: string): Promise<void> {
    const token = (entry.token += 1);
    entry.designer = undefined;
    entry.template = undefined;
    entry.kind = "generated";
    entry.builds += 1;
    entry.failed = undefined;
    try {
      const designer = await (await this.ensureChunk()).createPdfDesigner({
        formRoot: this.options.formRoot(),
        layout,
        values: this.options.values?.(),
        locale: this.locale(),
        textCatalog: this.textCatalog?.(),
        translations: this.formMap(),
        translationCatalog: this.options.translations?.(),
        dataSources: this.options.dataSources?.(),
        dataSourceResolver: this.options.dataSourceResolver,
        title: this.title(),
        pdfThemes: this.options.pdfThemes?.(),
        outputIntentProfiles: await this.hostProfiles(),
        formulaFunctions: this.formulaFunctionsValue
      });
      if (token !== entry.token) {
        return;
      }
      // The catalog moved on while the designer was built: a form rename followed into the
      // layout's condition (`formRenamed` passes over a designer not up yet). Built from the
      // layout as it was, this one would put the old id back; it is built again from the catalog.
      const current = this.model.layouts.find((candidate) => candidate.id === layout.id);
      if (current?.kind === "generated" && JSON.stringify(current) !== JSON.stringify(layout)) {
        await this.rebuildGenerated(entry, current, rootJson, valuesJson);
        return;
      }
      entry.designer = designer;
      // Opening a layout is no edit: the catalog keeps the layout as it holds
      // it, byte for byte — the name on the tree's root for the inspector's "Layout name" box
      // is the designer's own copy, and no default the definition lacks is written. The layout
      // stays on the page whatever the default does next.
      this.model.keepShown(layout.id);
      // The form's locales ride along: the layout's own text is authored in them. So do the
      // notes on its condition.
      entry.controller.setOptions({ ...designer.builderOptions, localization: this.options.localization?.(), notes: entry.notes });
      this.refreshReported(entry);
      entry.built = { rootJson, valuesJson };
      this.syncControls();
      this.options.onReady?.({ layout: designer.layout });
    } catch (error) {
      if (token === entry.token) {
        entry.failed = true;
        this.options.onError?.("The PDF designer could not be built for this form", error);
      }
    } finally {
      entry.builds -= 1;
    }
  }

  private inspectionFor(source: PdfTemplateSource): Inspected | undefined {
    return this.inspections.find((entry) => sameTemplate(entry.source, source));
  }

  /** The kernel's reading of a PDF, once per PDF: its bytes are kept for the pages and the preview. */
  private async inspect(source: PdfTemplateSource): Promise<Inspected> {
    const cached = this.inspectionFor(source);
    if (cached) {
      return cached;
    }
    const support = await this.ensureSupport();
    if (!support.provider.inspect) {
      throw new Error("This PDF provider cannot inspect templates");
    }
    const bytes = await (this.options.templates?.() ?? BASE64_TEMPLATE_RESOLVER).resolve(source);
    const info = await support.provider.inspect(buildPdfInspectRequest(bytes));
    const inspected = { source, bytes, info };
    this.inspections.push(inspected);
    return inspected;
  }

  /** {@link buildTemplate}, counted while it runs and marked when it fails, for {@link whenOpenReady}. */
  private async rebuildTemplate(entry: LayoutEntry, requested: PdfTemplateLayout, rootJson: string): Promise<void> {
    entry.builds += 1;
    entry.failed = undefined;
    const run = this.buildTemplate(entry, requested, rootJson);
    // The build took its token before its first wait: a later one supersedes it.
    const token = entry.token;
    try {
      await run;
    } catch (error) {
      if (token === entry.token) {
        entry.failed = true;
      }
      throw error;
    } finally {
      entry.builds -= 1;
    }
  }

  private async buildTemplate(entry: LayoutEntry, requested: PdfTemplateLayout, rootJson: string): Promise<void> {
    const token = (entry.token += 1);
    let layout = requested;
    entry.designer = undefined;
    entry.kind = "template";
    const kit = await this.ensureChunk();
    if (token !== entry.token) {
      return;
    }
    this.ensureSurface(entry, kit);
    let inspected = this.inspectionFor(layout.template);
    let problem: string | undefined;
    if (!inspected && this.canExecute()) {
      this.setStatus(entry, this.text("pdf.status.inspecting"));
      try {
        inspected = await this.inspect(layout.template);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (token !== entry.token) {
        return;
      }
    }
    const hostTemplates = await this.hostTemplates();
    const profiles = await this.hostProfiles();
    if (token !== entry.token) {
      return;
    }
    // The layout as the catalog holds it now: a form rename may have been followed into its
    // condition while the PDF was read (`formRenamed` passes over a designer not up yet).
    const current = this.model.layouts.find((candidate) => candidate.id === layout.id);
    if (current?.kind === "template" && sameTemplate(current.template, layout.template)) {
      layout = current;
    }
    const designer = kit.createPdfTemplateDesigner({
      layout,
      inspection: inspected?.info,
      formRoot: this.options.formRoot(),
      locale: this.locale(),
      translations: this.formMap(),
      translationCatalog: this.options.translations?.(),
      textCatalog: this.textCatalog?.(),
      hostTemplates,
      outputIntentProfiles: profiles
    });
    entry.template = designer;
    entry.built = { rootJson, valuesJson: "", template: layout.template };
    // Opening it is no edit: a default the definition lacks is not written here.
    this.model.replaceQuietly(layout.id, designer.layout, { declareDefault: false });
    entry.controller.setOptions({
      ...designer.builderOptions,
      localization: this.options.localization?.(),
      // The root's notes are the mode's (its condition); a widget's or an area's are
      // the designer's — whichever is current, since a form change swaps it (refreshTemplateComponents).
      notes: (edited, tree, componentId) => (componentId === tree.id ? entry.notes(edited, tree, componentId) : (entry.template?.notesFor(edited, tree, componentId) ?? [])),
      problems: (edited, tree, componentId) => (componentId === tree.id ? [] : (entry.template?.problemsFor(edited, tree, componentId) ?? []))
    });
    this.refreshReported(entry);
    entry.viewer?.setDocument(inspected?.info, inspected?.bytes);
    if (problem) {
      entry.failed = true;
      this.setStatus(entry, this.text("pdf.status.failed", { name: layout.template.name, provenance: templateProvenance(layout.template, this.words()), problem }), "error");
    } else if (inspected) {
      this.setStatus(entry, this.inspectionSummary(inspected.info, layout.template));
    } else {
      this.setStatus(entry, this.text("pdf.status.waiting", { name: layout.template.name, provenance: templateProvenance(layout.template, this.words()) }));
    }
    this.syncViewer(entry);
    this.syncControls();
    this.options.onReady?.({ layout: designer.layout });
  }

  private inspectionSummary(info: PdfTemplateInfo, source: PdfTemplateSource): string {
    const words = this.words();
    const pages = builderPlural("pdf.summary.pages", info.pageCount, undefined, words);
    // A field the kernel could not put on a page has no box on the viewer: say so rather than leave the author looking for it.
    const unplaced = info.fields.filter((field) => field.page === undefined).length;
    return (
      builderText("pdf.summary.lead", { name: source.name, provenance: templateProvenance(source, words) }, words) +
      (info.fields.length === 0
        ? builderText("pdf.summary.noFields", { pages }, words)
        : builderPlural("pdf.summary.fields", info.fields.length, { pages }, words)) +
      (unplaced > 0 ? builderPlural("pdf.summary.unplaced", unplaced, undefined, words) : "") +
      (info.hasXfa ? builderText("pdf.summary.xfa", undefined, words) : "") +
      (info.encrypted ? builderText("pdf.summary.encrypted", undefined, words) : "") +
      // Scripts are kept through a fill and run only in a viewer: the author is told, not stopped.
      (info.warnings?.some((warning) => warning.code.startsWith("template.javascript")) ? builderText("pdf.summary.scripts", undefined, words) : "") +
      (info.pdfa ? builderText("pdf.summary.pdfa", { level: info.pdfa }, words) : builderText("pdf.summary.notPdfa", undefined, words))
    );
  }

  private setStatus(entry: LayoutEntry, text: string, tone: "info" | "error" = "info"): void {
    if (entry.statusEl) {
      entry.statusEl.textContent = text;
      entry.statusEl.dataset.tone = tone;
    }
  }

  /** The surface a populated form shows on the canvas: a status line over the page viewer, built once per layout. */
  private ensureSurface(entry: LayoutEntry, kit: PdfDesignerModule): void {
    if (entry.surface && entry.viewer) {
      return;
    }
    const surface = document.createElement("div");
    surface.className = "dpd-template-surface";
    surface.setAttribute("data-template-surface", "");
    const status = document.createElement("p");
    status.className = "dpd-template-status";
    status.setAttribute("data-template-status", "");
    const controller = entry.controller;
    const viewer = kit.createTemplatePageViewer({
      rasterizer: async () => (await this.ensureSupport()).pages,
      escape: esc,
      locale: () => this.locale(),
      textCatalog: () => this.textCatalog?.(),
      // A box on a page is a node in the tree: picking it selects the node, through the
      // inspector's unsaved-edits guard like a click on the canvas.
      onSelect: (id) => {
        controller.requestSelect(id);
      },
      onFieldClick: (name) => {
        const id = entry.template?.widgetIdFor(name);
        if (id) {
          controller.requestSelect(id);
        }
      },
      // A rectangle drawn on empty paper is a new area: one undo entry, page and rectangle included.
      onAreaCreate: ({ page, rect }) => {
        controller.requestAdd(kit.PDF_AREA_COMPONENT_TYPE, controller.rootId(), kit.PDF_TEMPLATE_AREAS_SLOT, { configuration: { page, rect } });
      },
      // Moved, resized or nudged: while the area's own draft is open the rectangle joins it
      // (landed by Save, with the rest), otherwise it lands at once as one undo entry.
      onAreaChange: (id, rect) => {
        if (controller.selectedComponentId() === id && controller.hasPendingChanges(id)) {
          controller.setDraftProperty(id, "rect", rect);
        } else {
          controller.setProperty(id, "rect", rect);
        }
      },
      onAreaRemove: (id) => {
        controller.remove(id);
      }
    });
    // Beside the status, not in it: the status is replaced by each message (a fill's summary, a
    // rename's warning), and a stale map is a standing condition of the layout, said until mended.
    const stale = document.createElement("p");
    stale.className = "dpd-template-status";
    stale.setAttribute("data-template-stale", "");
    stale.dataset.tone = "warn";
    stale.hidden = true;
    // What Suggest mappings found: a standing note the author reads and dismisses, in a live
    // region so a screen reader hears it arrive. The status line is replaced by every message, so it is no place for it.
    const note = document.createElement("div");
    note.className = "dpd-template-note note";
    note.setAttribute("data-template-summary", "");
    note.setAttribute("role", "status");
    note.hidden = true;
    const noteText = document.createElement("span");
    noteText.setAttribute("data-template-summary-text", "");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn small";
    dismiss.setAttribute("data-template-summary-dismiss", "");
    dismiss.addEventListener("click", () => {
      note.hidden = true;
      noteText.textContent = "";
      // The note came of the bar's Suggest mappings: focus goes back to it rather than to nowhere.
      if (!this.suggestButtonEl.hidden) {
        this.suggestButtonEl.focus();
      }
    });
    note.append(noteText, dismiss);
    surface.append(status, stale, note, viewer.element);
    entry.surface = surface;
    entry.statusEl = status;
    entry.staleEl = stale;
    entry.noteEl = note;
    entry.viewer = viewer;
  }

  /** The page viewer over the tree as it stands (drafts laid over): the areas, and which fields are filled. */
  private syncViewer(entry: LayoutEntry): void {
    const designer = entry.template;
    const viewer = entry.viewer;
    if (!designer || !viewer || entry.kind !== "template") {
      return;
    }
    const root = entry.controller.previewSnapshot();
    const selected = entry.controller.selectedComponentId();
    const areas = designer.areasOf(root);
    viewer.setAreas(areas, selected !== undefined && areas.some((area) => area.id === selected) ? selected : undefined);
    // A field whose component the form lost is not filled: drawn as a warning, not as mapped.
    const unresolved = designer.missingSourcesOf(root, collectNodeIds(this.options.formRoot()));
    const mapped = designer.mappedFieldsOf(root);
    for (const name of unresolved.keys()) {
      mapped.delete(name);
    }
    viewer.setMapped(mapped, selected !== undefined ? designer.fieldNameOf(selected) : undefined, unresolved);
    // Value-map entries the form or the PDF has left behind: named for the whole layout, so
    // an author finds them without opening each widget. Advisory; the Values section has the button.
    if (entry.staleEl) {
      const said = designer.staleSummary(root);
      // Most edits leave the summary as it was: leave the DOM alone then.
      if (entry.staleEl.textContent !== (said ?? "")) {
        entry.staleEl.textContent = said ?? "";
      }
      if (entry.staleEl.hidden !== (said === undefined)) {
        entry.staleEl.hidden = said === undefined;
      }
    }
  }

  /**
   * Shows what the page holds: a populated form's pages in the sheet's place, the sheet for a
   * custom layout, and with no layout at all the empty state.
   */
  private applyView(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const selected = this.model.selected();
    if (!selected) {
      context.showCanvasSurface(this.emptySurface());
      return;
    }
    if (this.chunkFailure !== undefined && !this.chunk) {
      context.showCanvasSurface(this.failedSurface());
      return;
    }
    const entry = this.entries.get(selected.id);
    // The page viewer zooms itself; the canvas bar's zoom tools drive it.
    const viewer = selected.kind === "template" && entry?.kind === "template" ? entry.viewer : undefined;
    context.showCanvasSurface(
      selected.kind === "template" && entry?.kind === "template" ? entry.surface : undefined,
      // A template's page viewer is tryable too: its Try it draws the form in its place.
      viewer ? { zoom: (to) => viewer.zoom(to), zoomable: true, tryable: true } : undefined
    );
  }

  /**
   * A runtime handed in by Try it is the canvas's preview runtime, which holds no
   * layouts while this mode is registered (it is the one that edits them): it is read through a
   * view that answers `pdfConfiguration` with the layouts as edited here, so the answers choose
   * among them. A runtime that already names a configuration is left alone.
   */
  private withLayouts(runtime: RenderableRuntime): RenderableRuntime {
    if (runtime.pdfConfiguration?.() !== undefined) {
      return runtime;
    }
    const configuration = this.model.configuration;
    // The canvas's runtime lacks what the host's carries (the translations, the renditions, the
    // form id): the PDF it prints should match the bar's Preview PDF, so those come from there.
    const host = this.options.runtime() as unknown as Record<string, unknown>;
    return new Proxy(runtime, {
      get: (target, property) => {
        if (property === "pdfConfiguration") {
          return () => configuration;
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (value === undefined && (property === "translationCatalog" || property === "translations" || property === "pdfRenditionSources" || property === "formId")) {
          const fromHost = host[property];
          return typeof fromHost === "function" ? (fromHost as (...args: unknown[]) => unknown).bind(host) : fromHost;
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
  }

  private layoutName(layout: PdfLayoutDocument): string {
    return pdfLayoutLabel(layout, this.locale(), this.textSources());
  }

  /**
   * The templates a render resolves from: a PDF the kernel has already read is handed over as
   * bytes (an upload not yet saved by the host resolves nowhere else), whichever layout the
   * render turns out to print — a render by the answers cannot know it beforehand — and anything
   * else, such as a hosted upload the fill attaches, goes to the host's resolver.
   */
  private templateResolver(): PdfTemplateResolver | undefined {
    const host = this.options.templates?.();
    if (this.inspections.length === 0) {
      return host;
    }
    const fallback: PdfTemplateResolver = host ?? BASE64_TEMPLATE_RESOLVER;
    return {
      ...fallback,
      resolve: (source) => {
        const held = this.inspectionFor(source);
        return held ? Promise.resolve(held.bytes) : fallback.resolve(source);
      }
    };
  }

  /** Focus returns to what opened the preview (the Try panel re-renders, so it is looked up afresh). */
  private restoreFocus(): void {
    this.syncControls();
    const root = this.overlays[0]?.getRootNode();
    const tryButton =
      this.previewOrigin === "try" && root instanceof ShadowRoot
        ? root.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector<HTMLElement>("[data-try-pdf]")
        : undefined;
    (tryButton ?? this.previewButtonEl).focus();
  }

  /** The card a layout shows when the designer's chunk would not load: the shell's failed card, with Retry. */
  private failedSurface(): HTMLElement {
    if (!this.failedEl) {
      const element = document.createElement("div");
      element.className = "logic-state";
      element.setAttribute("role", "alert");
      element.addEventListener("click", (event) => {
        if (!(event.target as HTMLElement | null)?.closest("[data-pdf-retry]")) {
          return;
        }
        this.chunkFailure = undefined;
        void this.ensureFresh().then(() => this.applyView());
      });
      this.failedEl = element;
    }
    this.failedEl.innerHTML = `<p><strong>${esc(this.text("shell.load.failed.layouts"))}</strong></p><p>${esc(this.text("shell.load.check"))}</p><button type="button" class="btn" data-pdf-retry>${esc(this.text("shell.load.retry"))}</button>`;
    return this.failedEl;
  }

  /** The empty state: what a download prints without a layout, and the add popover under its button. */
  private emptySurface(): HTMLElement {
    if (!this.emptyEl) {
      const element = document.createElement("div");
      element.className = "empty-state is-page";
      element.setAttribute("data-pdf-empty", "");
      element.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-pdf-empty-add]");
        if (button) {
          this.openAdd(button);
        }
      });
      this.emptyEl = element;
    }
    // Worded each time it is shown, so a builder language switched since reads; drawn again only when the words moved.
    const html = `
        <h2>${esc(this.text("pdf.empty.title"))}</h2>
        <p>${esc(this.text("pdf.empty.body"))}</p>
        <p>${esc(this.text("pdf.empty.hint"))}</p>
        <button type="button" class="btn primary" data-pdf-empty-add>${esc(this.text("pdf.empty.add"))}</button>`;
    if (this.emptyHtml !== html) {
      this.emptyEl.innerHTML = html;
      this.emptyHtml = html;
    }
    return this.emptyEl;
  }

  private syncControls(): void {
    const canExecute = this.canExecute();
    const selected = this.model.selected();
    const entry = selected ? this.entries.get(selected.id) : undefined;
    const populated = selected?.kind === "template" && entry?.kind === "template" && entry.template?.inspection !== undefined;
    // A PDF with no fields has nothing to suggest for or to create from; its summary line already says so.
    const hasFields = populated && (entry?.template?.inspection?.fields.length ?? 0) > 0;
    this.suggestButtonEl.hidden = !hasFields;
    this.createFieldsButtonEl.hidden = !(hasFields && this.options.form?.() !== undefined);
    // Worded on every sync, so a builder language switched since reads in the next state change.
    this.suggestButtonEl.textContent = this.text("pdf.bar.suggest");
    this.suggestButtonEl.title = this.text("pdf.bar.suggest.title");
    this.createFieldsButtonEl.textContent = this.text("pdf.bar.createFields");
    this.createFieldsButtonEl.title = this.text("pdf.bar.createFields.title");
    this.previewButtonEl.disabled = !canExecute || this.previewBusy;
    this.previewButtonEl.textContent = this.text(this.previewBusy ? "pdf.bar.rendering" : "pdf.bar.preview");
    this.previewButtonEl.title = this.text(!canExecute ? "pdf.bar.preview.noExecutor" : selected ? "pdf.bar.preview.layout" : "pdf.bar.preview.derived");
    this.notifyDocuments();
    // The Form panel's PDF group redraws when what it says in words moved.
    const settings = this.conditionsSignature();
    if (settings !== this.settingsSignature) {
      this.settingsSignature = settings;
      for (const listener of [...this.settingsListeners]) {
        listener();
      }
    }
  }
}

/** The status line after "Create form fields": what was added and filled, and which fields were left out. */
function createFieldsSummary(result: CreateFormFieldsResult, ownName: (name: string) => string, words: BuilderTextOptions): string {
  const names = result.skipped.map((entry) => ownName(entry.pdfField));
  // Signature, button and read-only fields, mostly; each one's reason is in the result. Three are named, the rest counted.
  const list = formatListText(
    names.length > 3 ? [...names.slice(0, 3), builderText("pdf.fill.more", { count: names.length - 3 }, words)] : names,
    { ...words, type: "conjunction" }
  );
  if (result.added.length === 0 && result.mapped === 0) {
    return names.length > 0 ? builderText("pdf.fill.nothingLeft", { list }, words) : builderText("pdf.fill.nothingAll", undefined, words);
  }
  return builderText(
    "pdf.fill.done",
    {
      added: builderPlural("pdf.fill.formFields", result.added.length, undefined, words),
      filled: builderPlural("pdf.fill.pdfFields", result.mapped, undefined, words),
      had: result.matched > 0 ? builderText("pdf.fill.had", { count: result.matched }, words) : "",
      left: names.length > 0 ? builderText("pdf.fill.left", { list }, words) : ""
    },
    words
  );
}

/** Every id in a tree. */
function collectNodeIds(root: ComponentNode, into = new Set<string>()): Set<string> {
  into.add(root.id);
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      collectNodeIds(child, into);
    }
  }
  return into;
}

function containsNode(root: ComponentNode, id: string): boolean {
  return collectNodeIds(root).has(id);
}

/** The PDF designer as a builder mode: register it with `<datum-builder>.addMode()`. */
export function createPdfBuilderMode(options: PdfBuilderModeOptions): PdfBuilderMode {
  return new PdfBuilderModeImpl(options);
}

/** The paper of a custom layout in words ("Letter", "A4 landscape"); a custom size reads as such. */
function paperName(layout: PdfLayoutDocument, words: BuilderTextOptions): string | undefined {
  if (layout.kind !== "generated") {
    return undefined;
  }
  const setup = resolvePdfPageSetup((layout.root.configuration as { page?: unknown } | undefined)?.page);
  const size = typeof setup.size === "string" ? setup.size : builderText("pdf.paper.custom", undefined, words);
  return setup.orientation === "landscape" ? builderText("pdf.paper.landscape", { size }, words) : size;
}

/** What a preview rendered, as {@link PdfPreviewReport} says it: no bytes, no kernel message. */
function previewReportOf(result: RenderFormPdfResult): PdfPreviewReport {
  const report: PdfPreviewReport = {
    layoutId: result.layoutId,
    layoutChoice: result.layoutChoice,
    layoutKind: result.layoutKind,
    pageCount: result.pageCount,
    warnings: result.warnings.map((warning) => (warning.componentId !== undefined ? { code: warning.code, componentId: warning.componentId } : { code: warning.code }))
  };
  if (result.fields) {
    const filled = result.fields.filter((field) => field.status === "filled").length;
    report.fields = { filled, empty: result.fields.length - filled };
  }
  return report;
}

/** The element that has focus, looked for through open shadow roots (the builder's controls sit in several). */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Whether the person's focus is somewhere opening a dialog would take it from: the
 * browser's own panels or another window (the page lacks focus), or an element on the page other
 * than the dialog itself. Nothing focused on a focused page is not elsewhere.
 */
function focusIsElsewhere(dialog: HTMLElement): boolean {
  if (typeof document.hasFocus === "function" && !document.hasFocus()) {
    return true;
  }
  const active = deepActiveElement();
  return active !== null && active !== document.body && active !== document.documentElement && !dialog.contains(active);
}

/**
 * Whether an element sits in an inert subtree: an ancestor with `inert`, looked for across the
 * shadow roots it is in (the session's `inert` is on the builder element, the dialog in its shadow).
 */
function underInert(element: Element): boolean {
  for (let node: Element | null = element; node; ) {
    if (node.hasAttribute("inert")) {
      return true;
    }
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : node.parentElement;
  }
  return false;
}

/** How many answers were typed (not calculated, not the host's samples) into a runtime: its dirty keys. */
function typedAnswers(runtime: RenderableRuntime): number {
  const dirty = runtime.state().dirty as Iterable<string> | undefined;
  return dirty ? Array.from(dirty).filter((key) => !key.startsWith("@")).length : 0;
}

/** The moves of data the other way round: where an Undo of the step that made them sends the data. */
function reversedMoves(moves: ValuePathMoves | undefined): ValuePathMoves | undefined {
  if (moves === undefined) {
    return undefined;
  }
  const list: readonly ValuePathMove[] = Array.isArray(moves) ? (moves as readonly ValuePathMove[]) : [moves as ValuePathMove];
  const back = list.map((move) => ({ from: move.to, to: move.from }));
  return Array.isArray(moves) ? back : back[0];
}

/**
 * The layouts' block `current` with the change a history step made `from` one state `to`
 * another carried onto it: exactly `to` while the block still stands as `from` did, else the
 * layouts the step touched are changed, added (each after the nearest layout before it in `to`
 * that is there) or removed, matched by `id`, and the rest is kept.
 */
function carryPdfBlock(current: PdfConfiguration, from: PdfConfiguration, to: PdfConfiguration): PdfConfiguration {
  if (sameData(current, from)) {
    return structuredClone(to);
  }
  const carried = carryChange(current, from, to) as PdfConfiguration;
  const layouts = carryMembership(pdfLayoutsOf(carried), pdfLayoutsOf(from), pdfLayoutsOf(to));
  return { ...carried, layouts: layouts as PdfLayoutDocument[] };
}
