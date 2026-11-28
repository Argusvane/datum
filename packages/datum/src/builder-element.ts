import { loadBuilderFonts } from "./builder-fonts.js";
import { loadJourneyDiagnostics } from "./journey-debug.js";
import {
  BUILDER_WORKSPACES,
  DatumBuilderElement,
  JOURNEY_BUILDER_MODE,
  adoptBuilderHostControlStyles,
  builderFeatureOn,
  builderSides,
  defineDataSources,
  declaredDefaultLocale,
  onBindingsChanged,
  registeredBindings,
  readFormTranslationsReport,
  supportedLocaleCodes,
  defineDatumBuilderElement,
  isBuilderHostControlRoot,
  normalizeBuilderFeatures,
  parseBuilderFeatures,
  warnBuilderFeatureOnce,
  loadJourneyBuilderMode,
  definitionSizeProblem,
  loadPdfBuilderMode,
  loadedJourneyBuilderMode,
  loadedPdfBuilderMode,
  paletteEntriesOf,
  pdfLayoutConditionFindings,
  pdfLayoutsOf,
  renamePdfLayoutConditions,
  renameReferencesInConfiguration,
  type BuilderChangeReason,
  type BuilderController,
  type BuilderFeature,
  type BuilderFeatureSet,
  type BuilderFileActionDetail,
  type BuilderFileActions,
  type LocaleChanges,
  type TryItServerChecks,
  type TryItServerChecksSource,
  type WasmPluginModule,
  type WasmSandboxPolicy,
  type BuilderFormFile,
  type BuilderModeChangeDetail,
  type BuilderWorkspace,
  type BuilderWorkspaceChangeDetail,
  type ComponentDefinition,
  type DatumBuilderChangeDetail,
  type DatumBuilderComponentType,
  type DatumBuilderLayout,
  type DatumBuilderOptions,
  type BuilderCommandSource,
  type HostValidationCode,
  type DataSourceSet,
  type FormDefinition,
  type FormPlugin,
  type IconSet,
  type Journey,
  type JourneyBuilderMode,
  type JourneyBuilderModeModule,
  FormulaFunctionRegistry,
  isStarterSubmitButton,
  starterSubmitButton,
  bindingAssetsById,
  bindingById,
  type FormulaFunctionsSource,
  type JourneyConfiguration,
  type LiveAssets,
  type LiveBinding,
  type PdfBuilderMode,
  type PdfBuilderModeModule,
  type PdfBuilderModeSupport,
  type PdfBuilderModeSupportSource,
  type PdfConfiguration,
  type PdfLayoutDocument,
  type PdfPageRasterizer,
  type PdfTemplateResolver,
  type PdfThemeDefinition,
  type PrintTheme,
  type TranslationCatalog
} from "@argusvane/datum-engine";

import type { DatumFormDataSources } from "./form-element.js";
import { defaultPdfModuleUrl, loadPdfPageRasterizer, loadPdfSupport, resolvePdfModuleUrl, resolvePdfPagesModuleUrl } from "./pdf-loader.js";
import { pluginComponents, plugins as sharedPlugins, withPluginDataSources, type DatumPluginRegistry } from "./plugins.js";
import { createFormRuntime } from "./runtime-factory.js";
import { loadWasmValidationHost } from "./wasm-loader.js";
import { mergeComponentDefinitions, standardComponentTypes } from "./standard-components.js";
import { adoptPreUpgradeProperties } from "./pre-upgrade.js";
// The agent tools: a lazy chunk the opt-in `agent` token asks for; the entry holds only the loader and types.
import { loadBuilderAgent as loadAgent } from "./agent-loader.js";
import type { BuilderAgentAttachment } from "./agent.js";
import type { AgentTool, AgentToolResult, DesignerState } from "@argusvane/datum-engine/agent";
import {
  DEFAULT_FORM_IDENTITY,
  ElementBase,
  MAX_DEFINITION_BYTES,
  allowOriginsProblem,
  absoluteModuleAttribute,
  attributeOriginProblem,
  canDefineCustomElements,
  emit,
  emptyFormRoot,
  fetchJson,
  chromePartProblem,
  definitionTreeProblem,
  formDefinitionProblem,
  isDefinitionByteLimit,
  moduleAttributeUrl,
  journeyConfigurationProblem,
  pdfConfigurationProblem,
  parseJsonAttribute,
  parseList,
  codeOf,
  reportError,
  reportUnresolved,
  reportWarning,
  type DatumWarningDetail,
  toDefinitionByteLimit,
  toFormDefinition,
  unknownBuilderFeatureTokens,
  utf8Length
} from "./support.js";
import { themes as sharedThemes, type BuilderThemeInput, type DatumThemeRegistry, type PdfThemeInput } from "./themes.js";

export const DATUM_FORM_BUILDER_TAG = "datum-form-builder";

/** Where a renamed component's value moved in the data, when the rename carries it (the PDF layouts follow it). */
type RenamedDataPath = Parameters<typeof renamePdfLayoutConditions>[3];

/** A rename as the page is told it: its own copy, with the rules and notes the builder added and the path it moved. */
function copyOfRename<T extends { dataPath?: RenamedDataPath }>(renamed: T): T {
  const { rules, unparsed, dataPath } = renamed as T & { rules?: readonly string[]; unparsed?: readonly object[] };
  return {
    ...renamed,
    ...(rules ? { rules: [...rules] } : {}),
    ...(unparsed ? { unparsed: unparsed.map((note) => ({ ...note })) } : {}),
    ...(dataPath ? { dataPath: Array.isArray(dataPath) ? dataPath.map((move) => ({ ...move })) : { ...dataPath } } : {})
  };
}

/** One moved value path, before and after, as the builder's change announces it. */
type MovedValuePath = NonNullable<DatumBuilderChangeDetail["dataMoved"]>[number];

/**
 * Detail of `datum-builder-change`: the form as authored so far, and why it changed. `mode`
 * says which side changed — `"form"` for the tree, `"pdf"` for the PDF layouts (reasons
 * `"layouts"` and `"template"` are the latter's own), `"journeys"` for the journeys (reason `"journeys"` for the catalog — a journey added, renamed, copied, removed, made the default,
 * the form's "Opens as" — and `"form-rename"` for a form component's new id followed into them;
 * `"page-rename"` and `"journey-rename"` follow an edit that gave a journey page, or a journey, a
 * new id, so the form's tests are carried along).
 */
export interface DatumFormBuilderChangeDetail {
  definition: FormDefinition;
  reason: BuilderChangeReason | "layouts" | "template" | "journeys" | "form-rename" | "page-rename" | "journey-rename";
  mode: string;
  selectedComponentId: string | undefined;
  /**
   * Only on the form's change that gave a component a new id. The form's own
   * references are not rewritten; the journeys follow it themselves, in a `"form-rename"`
   * change of their own right after this one.
   */
  renamed?: { from: string; to: string; dataPath?: RenamedDataPath };
  /**
   * Only on the change an Undo or a Redo of a rename made: the component answers to `to` again,
   * as the builder's own change says it. A page that followed {@link renamed} in references of
   * its own follows this too.
   */
  renameStepped?: { from: string; to: string; by: "undo" | "redo" };
  /**
   * Only on the change of an edit that moved where answers are stored (a data key, a container's
   * key or `scopeData`): each moved value path before and after, to be followed as one map by a
   * page reading answers by path. The change an Undo made announces the moves reversed (the
   * answers go back) and the change a Redo made the same moves again, with {@link historyStep}.
   * The array is the page's own copy.
   */
  dataMoved?: readonly { from: string; to: string }[];
  /**
   * On every change an Undo or a Redo made, so a page can tell a redone {@link dataMoved} from a
   * new one: apply each change's map as it is told, once. A follower whose rewrite joined the
   * step's own entry (a registered mode) skips these changes: the entry already puts it back.
   */
  historyStep?: "undo" | "redo";
}

/** Detail of `datum-builder-binding-change`: the canvas's picker chose a binding (`"datum"` for Datum's own). */
export interface DatumFormBuilderBindingChangeDetail {
  bindingId: string;
}

/** Detail of `datum-builder-dirty-change`: whether the definition now differs from the saved one. */
export interface DatumFormBuilderDirtyChangeDetail {
  dirty: boolean;
}

/** Detail of `datum-builder-workspace-change`: the author moved between Form, Logic, Data, Languages, Journeys and PDF. */
export type DatumFormBuilderWorkspaceChangeDetail = BuilderWorkspaceChangeDetail;

/** Detail of `datum-builder-mode-change`: the author moved between the form and its PDF layouts. */
export type DatumFormBuilderModeChangeDetail = BuilderModeChangeDetail;

/** Detail of `datum-pdf-layout-change`: a change to the definition's PDF layouts, with the definition ready to save. */
export interface DatumPdfLayoutChangeDetail {
  layout: PdfLayoutDocument;
  pdf: PdfConfiguration;
  definition: FormDefinition;
  reason: BuilderChangeReason | "layouts" | "template";
}

/** Detail of `datum-pdf-layout-select`: the PDF mode moved to another of the form's layouts. */
export interface DatumPdfLayoutSelectDetail {
  layoutId: string;
  layout: PdfLayoutDocument;
}

/** Detail of `datum-pdf-designer-ready`: a layout is up on the PDF side. */
export interface DatumPdfDesignerReadyDetail {
  layout: PdfLayoutDocument;
}

/** Detail of `datum-journey-change`: a change to the definition's journeys, with the definition ready to save. */
export interface DatumJourneyChangeDetail {
  /** The journey the change concerns — edited, added, renamed, copied, removed, made the default — when there is one. */
  journey?: Journey;
  /** The definition's `journey` block as it stands; `undefined` once edited down to saying nothing. */
  configuration: JourneyConfiguration | undefined;
  definition: FormDefinition;
  /**
   * A builder reason for an edit on the canvas or in the inspector; `"journeys"` for the catalog;
   * `"form-rename"` for a form component's new id followed; `"page-rename"` and `"journey-rename"`
   * right after the edit that gave a page, or a journey, another id (see `renamed`).
   */
  reason: BuilderChangeReason | "journeys" | "form-rename" | "page-rename" | "journey-rename";
  /** Only on `"page-rename"` and `"journey-rename"`: the journey concerned and the id before and after. */
  renamed?: { journeyId: string; from: string; to: string };
}

/** Detail of `datum-journey-select`: the Journeys side moved to another of the form's journeys. Nothing in the definition changed. */
export interface DatumJourneySelectDetail {
  journeyId: string;
  journey: Journey;
}

type Update = "options" | "theme" | "preview" | "locale" | "layout" | "pdf" | "journeys" | "mode";

/** The order a flush applies the updates in; a throw leaves the ones after it still pending. */
const FLUSH_ORDER: readonly Update[] = ["layout", "theme", "options", "preview", "locale", "pdf", "journeys", "mode"];

/** Errors thrown while the form itself was being put into the builder (as against one of the settings around it). */
const formFailures = new WeakSet<object>();

/**
 * The attributes that name a module to import, or the endpoint the form is saved to, with the
 * property each sets: held to the page's origin (see attributeOriginProblem).
 */
const ORIGIN_BOUND_ATTRIBUTES: Readonly<Record<string, string>> = {
  wasm: "wasm",
  pdf: "pdf",
  "pdf-pages": "pdfPages",
  save: "save"
};

/** The requests `save-method` may name; the first is the one an absent attribute means. */
const SAVE_METHODS = ["PUT", "POST"] as const;

type SaveMethod = (typeof SAVE_METHODS)[number];

/** How long the element's own save request (`save="/url"`) may take before it counts as failed. */
const SAVE_TIMEOUT_MS = 30_000;

/** What the builder hands a Save: the languages changed since the last one, and who asked. */
type SaveContext = Parameters<NonNullable<BuilderFileActions["save"]>>[0];

function isDataSourceSet(value: DatumFormDataSources): value is DataSourceSet {
  return typeof (value as DataSourceSet).ids === "function" && typeof (value as DataSourceSet).has === "function";
}

/**
 * Whether a palette type passes the `component-types` filter: no filter offers everything;
 * entries name types to keep, or, led by `-`, types to drop, and a trailing `*` matches a
 * prefix (`-acme-*` drops a plugin's acme types). An exclusion wins; with exclusions
 * alone, everything else is offered.
 */
export function matchesTypeFilter(type: string, filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) {
    return true;
  }
  const hit = (pattern: string): boolean => (pattern.endsWith("*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern);
  const excluded = filter.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
  if (excluded.some(hit)) {
    return false;
  }
  const included = filter.filter((entry) => !entry.startsWith("-"));
  return included.length === 0 || included.some(hit);
}

/**
 * What `fileActions` takes on `<datum-form-builder>`: the host's own New, Open or Download in
 * place of the element's, and its Save (which wins over the one the `save` attribute turns on),
 * a key set to `null` putting that button away, a key left out (or
 * `undefined`) keeping the element's own.
 */
export type DatumFormBuilderFileActions = {
  [K in keyof BuilderFileActions]?: NonNullable<BuilderFileActions[K]> | null | undefined;
};

/**
 * Detail of `datum-builder-file-action`: which of the bar's file actions completed (New, Open,
 * Download), the file's name when there is one, and the definition as it stands after it —
 * the new form after New or Open, ready to save. A Save a browser assistant asked for carries
 * `trigger: "agent"`, passed on from the builder's own event as it came; the
 * person's own Save carries none.
 */
export type DatumFormBuilderFileActionDetail = BuilderFileActionDetail & {
  definition: FormDefinition;
  /**
   * Only on a Download that left something worth saying: what the saved form lacks (it has no
   * submit button, so nobody can send it). The notice on the builder says the same; the
   * download itself goes ahead.
   */
  warnings?: DatumFormBuilderFileWarning[];
};

/** One thing a Download warned about (see {@link DatumFormBuilderFileActionDetail.warnings}). */
export interface DatumFormBuilderFileWarning {
  code: "no-submit-button";
  message: string;
}

/**
 * Detail of `datum-builder-save`: the element's own Save (the `save` attribute) was chosen,
 * past the unsaved-edits guard. A page that stores the form itself (a bare `save`) does it here
 * and hands the work to `waitUntil`; one that only adds to the element's own request
 * (`save="/url"`) listens for what it needs and lets the request go ahead, or calls
 * `preventDefault()` to do the storing in its place.
 */
export interface DatumFormBuilderSaveDetail {
  /** The form as authored: what this save stores, and the saved baseline once it succeeds. */
  definition: FormDefinition;
  /** The net change to the form's languages since it was loaded or last saved, for a page keeping a translation catalog. */
  localeChanges: LocaleChanges;
  /** `"agent"` when a browser assistant asked for the save; absent when the person did. */
  trigger?: "agent";
  /**
   * Has the save wait for `work`: the menu's item reads "Saving…" until it settles, and a
   * rejection is the save failing, its message shown beside the menu. Called while the event is
   * being dispatched; any number of listeners may each hand in their own.
   */
  waitUntil(work: Promise<unknown>): void;
}

type FileActionName = "new" | "open" | "download";

const FILE_ACTION_NAMES: readonly FileActionName[] = ["new", "open", "download"];

/**
 * Whether two `features` lists name the same parts apart from the opt-in `agent` token: an absent list is every part but the opt-in ones, the same as `all`.
 */
function differsOnlyInAgent(previous: BuilderFeatureSet, next: BuilderFeatureSet): boolean {
  const words = (set: BuilderFeatureSet): string[] => [...(set ?? parseBuilderFeatures("all") ?? [])].filter((feature) => feature !== "agent").sort();
  const before = words(previous);
  const after = words(next);
  return before.length === after.length && before.every((feature, index) => feature === after[index]);
}

/**
 * The file actions the `file-actions` attribute names: `undefined` for the element's own
 * default (absent, `"auto"`, empty), none for `"off"` or `"none"`, else those a space- or
 * comma-separated list names (anything else in it is ignored).
 */
function parseFileActions(value: string | null): ReadonlySet<FileActionName> | undefined {
  const spec = value?.trim();
  if (spec === undefined || spec === "" || spec === "auto") {
    return undefined;
  }
  if (spec === "off" || spec === "none") {
    return new Set();
  }
  const listed = parseList(spec);
  return new Set(FILE_ACTION_NAMES.filter((name) => listed.includes(name)));
}

/** The host's action when it gave one, none when it put it away (`null`), else the element's own. */
function chosenAction<T>(override: T | null | undefined, own: T): T | undefined {
  return override === null ? undefined : (override ?? own);
}

/** `<form id>.json`, with anything a file system would object to in the id replaced; `form.json` for an id with nothing left. */
function formFileName(id: string): string {
  const stem = id
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return `${stem || "form"}.json`;
}

/**
 * The file a Download is named after the form's title, slugified: a form the author
 * called "Customer intake" saves as `customer-intake.json` whatever its id says. A form with no
 * title, or one with nothing a file name can keep (a title in a script the slug drops), falls
 * back to the id.
 */
function downloadFileName(definition: FormDefinition): string {
  const title = (definition.root.configuration as { title?: unknown } | undefined)?.title;
  const text = typeof title === "string" ? title : title && typeof title === "object" && typeof (title as { default?: unknown }).default === "string" ? (title as { default: string }).default : "";
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.json` : formFileName(definition.id);
}

/**
 * An id for the form File > New starts: neutral, and not the last form's — the
 * demo's `customer-intake` would otherwise name every download. Six random base-36 digits, so
 * two forms started in one session do not share an id.
 */
function freshFormId(): string {
  const bytes = new Uint8Array(4);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const digits = [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("");
  return `form-${digits.slice(0, 6)}`;
}

/**
 * The form a builder starts on, and the one File > New makes: an empty root holding the one Submit
 * button every form starts with, so a form can be sent as it stands. The same button
 * Try it's notice adds to a form without one (`starterSubmitButton`). A definition the page
 * supplies never goes through here.
 */
function startingFormRoot(): FormDefinition["root"] {
  const root = emptyFormRoot();
  root.children = { content: [starterSubmitButton()] };
  return root;
}

/** Whether a button anywhere in the tree submits the form (`action` `submit`, or `download`, which submits and saves the file). */
function hasSubmitButton(node: FormDefinition["root"]): boolean {
  if (node.type === "button") {
    const action = (node.configuration as { action?: unknown } | undefined)?.action;
    if (action === "submit" || action === "download") {
      return true;
    }
  }
  return Object.values(node.children ?? {}).some((group) => (group ?? []).some((child) => hasSubmitButton(child)));
}

/** The text-table key of what a Download says when the form it saves has no submit button. */
const NO_SUBMIT_WARNING_KEY = "shell.file.noSubmitWarning";
/** The tokens this element's own shadow root reads (status card, Download notice, assistant banner), set on its host while dark. */
const SCHEME_LOOK_TOKENS: readonly string[] = ["--db-surface", "--db-ink", "--db-warn-soft", "--db-warn-line", "--db-focus", "--db-line-card"];

/**
 * The form builder as one element a page configures with a form definition and plain data:
 * the component palette, the canvas (previewing through the real renderer) and the properties
 * inspector, with no application chrome around them. It is the HTML *and* the PDF builder:
 * a Form | PDF switch on its top bar moves between the form tree and the form's
 * PDF layouts, the PDF side being the same builder over a layout tree, with its own Layouts
 * and template-mode dialogs. The PDF executor — the kernel that previews, test-fills and
 * inspects — is fetched on the first use, as a chunk of this bundle, so nothing needs
 * configuring; `pdf="off"` hides the PDF side for a page that never wants it. The form's
 * journeys are a side of their own: a Journeys entry per journey in the
 * documents dropdown, each edited as pages of the form's questions with routes between them,
 * its designer a chunk of this bundle loaded when the side is first opened; `journeys="off"`
 * leaves it out, the definition's journeys passing through as they are.
 *
 * ```html
 * <datum-form-builder layout="contained" style="height: 720px"
 *   src="/forms/intake.json"></datum-form-builder>
 * <script type="module">
 *   const builder = document.querySelector("datum-form-builder");
 *   builder.addEventListener("datum-builder-change", (event) => save(event.detail.definition));
 * </script>
 * ```
 *
 * `layout="contained"` keeps the bar, the panels and the canvas inside the element's box (the
 * page sizes it); the default `"page"` layout pins the shell to the window, for a builder that
 * is the page. The bar leads with the builder's own file actions — New, Open and Download,
 * over the whole definition: tree, languages, identity, PDF layouts, journeys and tests — each behind
 * the unsaved-edits guard, New and Open asking before they replace the form, and each reported
 * as a `datum-builder-file-action` event carrying the definition after it; `file-actions` picks which show (`"off"` for none, or a
 * list such as `"open download"`), and `fileActions` hands in the page's own for any of them.
 * Save joins them only when the page asks for it: `save="/url"` has the element send the form to
 * that address itself, a bare `save` leaves the storing to a `datum-builder-save` listener, and
 * `fileActions.save` takes a function; `save-label` names the item.
 * A page left with unsaved work — a reload, a link followed, the tab closed — would lose it, so
 * while the form is `dirty` or an edit is still held in a panel the element has the browser ask
 * before the page goes (`beforeunload`: the browser's own question, in its own words);
 * `leave-guard="off"` leaves that to a page that keeps the work some other way.
 * The `toolbar-start`, `toolbar` and `canvas-actions` slots take the page's own controls, all
 * on the shell's bar: the first after the file actions, the other two trailing the document
 * tabs centred between them. A button or select slotted there — and a launcher on
 * the inner builder's `strip` — is drawn in the builder's own look, from its tokens, which any
 * class of the page's still overrides.
 */
export class DatumFormBuilderElement extends ElementBase {
  static get observedAttributes(): string[] {
    return [
      "definition",
      "src",
      "max-definition-bytes",
      "theme",
      "load-fonts",
      "debug",
      "pdf-theme",
      "layout",
      "locale",
      "data-sources",
      "data-source-ids",
      "validation-codes",
      "component-types",
      "pdf",
      "pdf-pages",
      "journeys",
      "values",
      "translations",
      "mode",
      "persist-panels",
      "file-actions",
      "save",
      "save-method",
      "save-label",
      "workspace",
      "workspaces",
      "hidden-workspaces",
      "layout-id",
      "hidden-panels",
      "managed-settings",
      "features",
      "full-window",
      "no-full-window",
      "scheme",
      "no-scheme-toggle",
      "wasm",
      "allow-origins",
      "leave-guard"
    ];
  }

  private readonly root: ShadowRoot;
  private builderEl: DatumBuilderElement | undefined;

  /**
   * Where answers moved with each rename the form made, by the ids as first made (`from>to`), `[]` when
   * the answer did not move: its Undo (turned round) and its Redo move the layouts' paths the same way.
   */
  private readonly seededDataPaths = new Map<string, MovedValuePath[]>();
  /**
   * The steps (a rename by its ids, an edit by its first moved path, as first made) the seed route
   * followed into a side's seed while that side had no mode. Such a step has no entry of its own in
   * the mode's history, so once the mode has registered its Undo and Redo are followed here.
   */
  private readonly seededSteps: Record<"pdf" | "journeys", Set<string>> = { pdf: new Set(), journeys: new Set() };

  private seed: FormDefinition = { ...DEFAULT_FORM_IDENTITY, root: startingFormRoot() };
  /**
   * The seed the builder last took, kept from the moment the `definition` property replaces it
   * until the builder has taken the new one: a form the builder cannot be seeded with is put back.
   */
  private seedBeforeReplace: FormDefinition | undefined;
  private srcValue: string | undefined;
  private srcToken = 0;
  /** Whether a `src` fetch is on its way: until it lands (or `src` is cleared), no definition replaces the form. */
  private srcLoading = false;
  /**
   * Whether the form in place is one the page assigned (the property or the attribute) or the
   * author brought by New or Open, not one `src` brought: while it is, `src` is refused.
   */
  private definitionAssigned = false;
  /** Whether the author edited while the `src` fetch on its way was pending: its form is then not put over the edits. */
  private editedWhileSrcLoads = false;
  /** What the page hears about the form just set (entries left out), once the builder has taken it. */
  private heldLoadWarning: DatumWarningDetail | undefined;
  private maxDefinitionBytesValue = MAX_DEFINITION_BYTES;
  private themeValue: BuilderThemeInput = undefined;
  /** The binding the canvas draws the form with: a binding, a registered id, or nothing for Datum's. */
  private bindingValue: LiveBinding | string | undefined = undefined;
  private assetsValue: LiveAssets | undefined = undefined;
  private loadFontsValue = false;
  /** `debug`: log what the journey diagnostics find. */
  private debugValue = false;
  private unsubscribeBindings: (() => void) | undefined;
  /** The registry the `theme` and `pdf-theme` ids resolve through: the page's shared one unless a host sets its own. */
  private themesValue: DatumThemeRegistry = sharedThemes;
  private unsubscribeThemes: (() => void) | undefined;
  /** Theme ids reported as unknown and not resolved since: retried on every registration, reported once. */
  private readonly unresolvedThemes = new Set<string>();
  private layoutValue: DatumBuilderLayout = "page";
  private localeValue: string | undefined;
  private dataSourcesValue: DataSourceSet | undefined;
  private dataSourceIdsValue: string[] = [];
  private validationCodesValue: HostValidationCode[] = [];
  private componentTypesFilter: string[] | undefined;
  private componentTypesValue: DatumBuilderComponentType[] = [];
  private componentDefinitionsValue: ComponentDefinition[] = [];
  /** Plugins for this builder alone, beside the page's. */
  private pluginsValue: FormPlugin[] = [];
  /** The registry the page's plugins come from: the shared one unless a host sets its own. */
  private pluginRegistryValue: DatumPluginRegistry = sharedPlugins;
  private unsubscribePlugins: (() => void) | undefined;

  private pdfValue: string | undefined;
  private pdfPagesValue: string | undefined;
  private pdfSupportValue: PdfBuilderModeSupport | undefined;
  private pdfThemeValue: PdfThemeInput = undefined;
  private pdfTemplatesValue: PdfTemplateResolver | undefined;
  private iconsValue: IconSet | undefined;
  private formulaFunctionsValue: FormulaFunctionsSource | undefined;
  private textLocaleValue: string | undefined;
  private textCatalogValue: DatumBuilderElement["textCatalog"];
  private formulaReferenceHrefValue: string | undefined;
  private printThemeValue: PrintTheme | undefined;
  private valuesValue: Record<string, unknown> = {};
  private translationsValue: TranslationCatalog | undefined;
  private pdfModeValue: PdfBuilderMode | undefined;
  private journeysValue: string | undefined;
  private journeyModeValue: JourneyBuilderMode | undefined;
  /**
   * The PDF and Journeys modes are chunks, fetched only for a side that is on and a
   * workspace that is shown. Each apply bumps its token, so a load that resolves after
   * `pdf="off"` / `journeys="off"`, a hidden workspace or a later apply registers nothing; the
   * flag says a load is in flight, for a switch to that side asked for meanwhile.
   */
  private pdfModeToken = 0;
  private pdfModeLoading = false;
  private journeyModeToken = 0;
  private journeyModeLoading = false;
  /** A designer workspace (`"pdf"`, `"journeys"`) asked for while its mode's chunk was coming: entered once it registers. */
  private pendingDesignerWorkspace: BuilderWorkspace | undefined;
  /** A side (`mode`, `setMode`) asked for while its mode's chunk was coming: put on the page once it registers, unless the author moved on meanwhile. */
  private pendingDesignerMode: string | undefined;
  /** While a late mode registers and catches up: the builder's own workspace and mode events then are not the author moving on. */
  private registeringLateMode = false;
  /**
   * A side whose mode's chunk failed to load (absent-code resilience): an inline card
   * with Retry says so, and the next flush (a reconnect, any change, Retry) tries the chunk again.
   */
  private pdfModeFailed = false;
  private journeyModeFailed = false;
  /** The status card's markup as last written, so it is written only when it changes. */
  private modeStatusMarkup = "";
  /** Sides whose chunk failed: asked for again on a reconnect or Retry, never by an unrelated flush. */
  private readonly failedSides = new Set<"pdf" | "journeys">();
  /** The module attributes whose value was refused (another origin): what a change to `allow-origins` looks at again. */
  private readonly refusedUrlAttributes = new Set<string>();
  /**
   * The module attributes whose own callback has run: an element upgraded from markup has every
   * attribute before the first callback, and `allow-origins` must not apply (and report) one
   * whose callback is still to come.
   */
  private readonly seenUrlAttributes = new Set<string>();
  /** Sides the author pressed Retry on and whose chunk is still coming: the card stays, busy, so focus has somewhere to stay. */
  private readonly retryingSides = new Set<"pdf" | "journeys">();
  private modeValue: string | undefined;
  private showModeSwitchValue = true;
  private hiddenModeIdsValue: string[] = [];
  /** `persist-panels`: the key the shell remembers its panels under; none, nothing is remembered. */
  private persistPanelsValue: string | undefined;
  /** The workspace asked for and the ones the host leaves off; the inner builder holds the live ones. */
  private workspaceValue: BuilderWorkspace | undefined;
  private hiddenWorkspacesValue: BuilderWorkspace[] = [];
  /** `workspaces`: the only workspaces the bar offers; `undefined` (no list) offers them all. */
  private workspacesValue: BuilderWorkspace[] | undefined;
  /**
   * The `features` list: `undefined` when none was given, where every part of the
   * builder exists as before; else only the parts it names. The list is the master of `pdf`,
   * `journeys`, `hidden-workspaces` and `hidden-panels`, which can only take more away.
   */
  private featuresValue: BuilderFeatureSet = undefined;
  /** `hidden-panels`: the strip panels the host leaves off; the inner builder holds the live ones. */
  private hiddenPanelsValue: string[] = [];
  private managedSettingsValue: string[] = [];
  /**
   * The saved baseline: the definition as last saved, as JSON. Set from the
   * definition a page loads, then by `markSaved()` or `savedDefinition`; `dirty` compares with it.
   */
  /** The page's palette commands, handed to each builder this element builds. */
  private readonly commandSourcesValue = new Set<BuilderCommandSource>();
  private savedSignature: string | undefined;
  /** The saved baseline parsed once per signature, for the getter. */
  private savedParsed: { signature: string; definition: FormDefinition } | undefined;
  private baselinePending = true;
  /** Whether the baseline is the definition as loaded (not a host's `markSaved` / `savedDefinition`), and untouched since. */
  private baselineFromLoad = false;
  private editedSinceBaseline = false;
  private dirtyValue = false;
  /**
   * Leaving the page with unsaved work asks first: the form differs from the saved one, or an
   * edit is still held in a panel. The browser asks, in its own words; nothing else can stop a
   * page from going. `leave-guard="off"` is read when the page is about to go, so a page can
   * turn it off (or back on) at any time.
   */
  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.getAttribute("leave-guard") === "off" || !(this.dirty || this.hasUnsavedChanges())) {
      return;
    }
    event.preventDefault();
    // What browsers before `preventDefault()` counted here still read.
    event.returnValue = true;
  };
  /**
   * The committed form (tree, identity, languages) as the last form-side `datum-builder-change`
   * carried it, as JSON. A later `"edit"` that leaves it as it was — a draft typed into the
   * inspector, an Apply the form refused — is not announced.
   */
  private lastAnnouncedForm: string | undefined;
  private diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The PDF layout to put on the page when the PDF side is first set up (`layout-id`). */
  private initialPdfLayoutId: string | undefined;
  /** The page's own file actions over the element's (`fileActions`): a function replaces one, `null` puts it away. */
  private fileActionsOverride: DatumFormBuilderFileActions | undefined;
  private serverChecksValue: TryItServerChecks | undefined;
  private wasmValue: string | undefined;
  /** Try it's WebAssembly validator from `wasm`, built once per module URL and plugin set (see {@link wasmChecks}). */
  private wasmChecksMemo: { spec: string; plugins: readonly WasmPluginModule[]; source: TryItServerChecksSource } | undefined;
  /** The file actions `file-actions` names; `undefined` shows all three. */
  private fileActionsNamed: ReadonlySet<FileActionName> | undefined;
  /**
   * `save`: the menu has a Save. `true` (the bare attribute) leaves the storing to the page's
   * `datum-builder-save` listener; a string is the address the element sends the form to itself.
   */
  private saveValue: string | boolean = false;
  private saveMethodValue: SaveMethod = SAVE_METHODS[0];
  /** `save-label`: Save's name in the menu, whichever Save it is. */
  private saveLabelValue: string | undefined;
  /**
   * The element's own file actions, over its whole definition — the tree, the languages, the
   * identity, the PDF layouts, the journeys: New starts a form under a fresh neutral id (the
   * version and schema version are kept) holding one Submit button; Open takes a definition (or
   * a bare form tree) from a JSON file, refusing one the builder could not take (see
   * `formDefinitionProblem`); Download saves the definition as JSON, named after the form's
   * title, else its id. `isEmpty` tells the builder when New has nothing to lose,
   * whichever New the page uses: an empty tree, nothing set on the form, no languages, no
   * journeys, no tests, and no PDF layout but the one the PDF side derives for an empty form.
   */
  private readonly ownFileActions = {
    new: (): void => {
      const { version, schemaVersion } = this.definition;
      // A neutral id of its own, not the last form's; a Submit button so the form
      // can be sent as it stands.
      this.replaceDefinition({ id: freshFormId(), version, schemaVersion, root: startingFormRoot() });
    },
    open: (file: BuilderFormFile): (() => void) => {
      this.refuseWhileSrcLoads();
      // Measured before it is parsed, as every other import is.
      const tooLarge = definitionSizeProblem(utf8Length(file.text), this.maxDefinitionBytesValue);
      if (tooLarge) {
        throw new Error(tooLarge);
      }
      let json: unknown;
      try {
        json = JSON.parse(file.text) as unknown;
      } catch (error) {
        throw new Error(`it is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const definition = toFormDefinition(json);
      const problem = formDefinitionProblem(definition);
      if (problem) {
        throw new Error(problem);
      }
      return () => this.replaceDefinition(definition);
    },
    download: (): { name: string; text: string; type: string } => {
      const definition = this.definition;
      return { name: downloadFileName(definition), text: `${JSON.stringify(definition, null, 2)}\n`, type: "application/json" };
    },
    isEmpty: (): boolean => {
      const definition = this.definition;
      const root = definition.root;
      // The Submit button New seeds, untouched, is not work to lose: a New after a New asks nothing.
      if (Object.values(root.children ?? {}).some((group) => (group ?? []).some((child) => !isStarterSubmitButton(child)))) {
        return false;
      }
      // A setting cleared on the Form panel can stay behind as a key with no value: nothing set.
      const configured = Object.values(root.configuration ?? {}).some((value) => value !== undefined);
      if (configured || definition.localization !== undefined || definition.journey !== undefined || definition.tests !== undefined) {
        return false;
      }
      // Every layout is someone's work: the PDF side derives none for an empty form.
      return (definition.pdf?.layouts?.length ?? 0) === 0;
    }
  } satisfies Required<Omit<BuilderFileActions, "save" | "saveLabel">>;

  private readonly pending = new Set<Update>();
  private flushQueued = false;
  /**
   * While a reseed runs (the builder's options, then the PDF and Journeys sides): the builder's
   * `"init"` change is held until every side is on the new form, so the `datum-builder-change`
   * it becomes carries that form's layouts and journeys, not the old ones.
   */
  private reseeding = false;
  /**
   * The scheme seam with the inner builder: `reflectingScheme` while this element
   * writes the inner's scheme onto its own attribute (nothing to forward back), and
   * `forwardingSchemeRemoval` while the page's removal goes in (the inner's answer is not written
   * back, or the page could never hand the choice back to the remembered one).
   */
  private reflectingScheme = false;
  private forwardingSchemeRemoval = false;
  /** Whether the `scheme` attribute here is this element's own reflection of the inner's, not the page's choice. */
  private schemeAttributeReflected = false;
  /** What the page had set inline on this host before {@link syncSchemeLook} laid the dark look over it. */
  private heldSchemeLook = new Map<string, string>();
  /** Whether {@link syncSchemeLook} wrote the dark look on this element's own host. */
  private schemeLookApplied = false;
  private heldInit: DatumBuilderChangeDetail | undefined;
  /**
   * The agent tools, while the `agent` token is on and the element is on the page: the
   * per-connection controller whose signal unregisters the builder, and the chunk's attachment
   * once it has landed (undefined when the element left before it did). The attachment registers
   * the builder's own catalogue (its twenty-four tools, beside the page's session pair) over this
   * element's host (`builder/agent-host.ts`).
   */
  private agentAbort: AbortController | undefined;
  private agentAttachment: Promise<BuilderAgentAttachment | undefined> | undefined;
  private agentLive: BuilderAgentAttachment | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    defineDatumBuilderElement();
    // Every change this element reports, from any side: the dirty flag and the problem counts follow.
    this.addEventListener("datum-builder-change", (event) => this.afterChange((event as CustomEvent<{ reason: string }>).detail.reason));
    // Ctrl/Cmd+S downloads the form when the page has no Save of its own: the key
    // would otherwise ask the browser to save the page. Only a key pressed inside the builder
    // reaches here, and one the inner builder already took for the page's Save is left alone.
    this.addEventListener("keydown", (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "s" &&
        !event.defaultPrevented &&
        typeof this.fileActions.download === "function"
      ) {
        const item = this.builderEl?.shadowRoot?.querySelector<HTMLElement>("[data-file-download]");
        if (item) {
          event.preventDefault();
          item.click();
        }
      }
    });
  }

  public connectedCallback(): void {
    adoptPreUpgradeProperties(this);
    // The builder's look for the controls the page slots onto this element: they are this
    // element's children, so the stylesheet goes into the root this element lives in (the
    // document, or the page's own shadow root), not the one the inner builder lives in.
    const hostRoot = this.getRootNode();
    if (isBuilderHostControlRoot(hostRoot)) {
      adoptBuilderHostControlStyles(hostRoot);
    }
    if (!this.builderEl) {
      this.buildDom();
      // Everything at once on first connect: the options carry the seed, the rest follows.
      // A side whose chunk failed is in `failedSides`, so a reconnect tries it again.
      this.pending.add("options");
      this.pending.add("theme");
      this.pending.add("layout");
      this.pending.add("pdf");
      this.pending.add("journeys");
      this.pending.add("mode");
    }
    // A side whose chunk failed is asked for again here (a reconnect), not by every later flush.
    for (const side of this.failedSides) {
      this.pending.add(side);
    }
    this.failedSides.clear();
    this.watchThemes();
    this.watchBindings();
    this.watchPlugins();
    this.syncAgent();
    this.safeFlush();
    window.addEventListener("beforeunload", this.onBeforeUnload);
  }

  public disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.unsubscribeThemes?.();
    this.unsubscribeThemes = undefined;
    this.unsubscribeBindings?.();
    this.unsubscribeBindings = undefined;
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = undefined;
    // Off the page: the agent registration goes with it (synchronously, so the browser's tool list follows at once).
    this.syncAgent();
  }

  /**
   * The registry the `theme` and `pdf-theme` ids resolve through: the page's shared `themes` unless a host hands the element one of
   * its own. A theme registered after the element connected reaches the pickers and
   * resolves an id the page could not resolve yet.
   */
  public get themes(): DatumThemeRegistry {
    return this.themesValue;
  }

  public set themes(value: DatumThemeRegistry | undefined) {
    this.themesValue = value ?? sharedThemes;
    // Off the page the element listens to nothing: connecting subscribes, and a subscription
    // taken now would hold the element for the registry's lifetime (the page's, for the shared one).
    if (this.isConnected) {
      this.watchThemes();
    }
    this.onThemesChanged();
  }

  private watchThemes(): void {
    this.unsubscribeThemes?.();
    this.unsubscribeThemes = this.themesValue.subscribe(() => this.onThemesChanged());
  }

  /** The shell theme is re-resolved without reseeding the tree. */
  private onThemesChanged(): void {
    if (!this.builderEl) {
      return;
    }
    this.request("theme");
  }

  /** The canvas's picker follows the bindings the page registers, without reseeding the tree. */
  private watchBindings(): void {
    this.unsubscribeBindings?.();
    this.unsubscribeBindings = onBindingsChanged(() => {
      this.builderEl?.controller.setOptions({ availableBindings: this.availableBindings() });
    });
  }

  /**
   * The bindings the canvas's picker offers: Datum's own, then each the page registered, with the
   * design system's files it was registered with (`bindings.register(binding, { assets })`), so a
   * binding picked on the canvas draws with them.
   */
  private availableBindings(): NonNullable<DatumBuilderOptions["availableBindings"]> {
    return [
      { id: "datum", label: "Datum" },
      ...registeredBindings().map((binding) => {
        const assets = bindingAssetsById(binding.id);
        return { id: binding.id, label: binding.label, binding, ...(assets !== undefined ? { assets } : {}) };
      })
    ];
  }

  /**
   * The registry the page's plugins come from: the shared `plugins` unless a host
   * hands the element one of its own. A plugin registered after the element connected
   * reaches the palette, the catalogue and the canvas without reseeding the tree.
   */
  public get pluginRegistry(): DatumPluginRegistry {
    return this.pluginRegistryValue;
  }

  public set pluginRegistry(value: DatumPluginRegistry | undefined) {
    this.pluginRegistryValue = value ?? sharedPlugins;
    // As for `themes`: connecting subscribes, so a detached element holds no subscription.
    if (this.isConnected) {
      this.watchPlugins();
    }
    this.onPluginsChanged();
  }

  private watchPlugins(): void {
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = this.pluginRegistryValue.subscribe(() => this.onPluginsChanged());
  }

  /**
   * The palette, the catalogue and the canvas's sources follow the registry. The catalogue is
   * swapped under the tree as it stands (`setComponentDefinitions`), so what the author has
   * placed stays, and so do the undo history, the edits not yet applied and the selection; only
   * the sources go through `setOptions`, which rebuilds nothing when it is not given the
   * catalogue. The PDF side and the sample runtime read the catalogue through closures, so
   * they follow on their own.
   */
  private onPluginsChanged(): void {
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    builder.controller.setComponentDefinitions(this.mergedDefinitions(), this.paletteTypes());
    builder.controller.setOptions({ dataSources: this.previewDataSources() });
    builder.formulaFunctions = this.wiredFormulaFunctions();
  }

  /**
   * The plugin formula functions the builder lists and parses: the host's own `formulaFunctions`
   * when it set one, else a registry filled from the formula functions the page's and this
   * element's plugins contribute (a clash is skipped here; the runtime reports it).
   */
  private wiredFormulaFunctions(): FormulaFunctionsSource | undefined {
    if (this.formulaFunctionsValue) {
      return this.formulaFunctionsValue;
    }
    const registry = new FormulaFunctionRegistry();
    let any = false;
    for (const plugin of this.allPlugins()) {
      for (const contribution of plugin.formulaFunctions ?? []) {
        try {
          registry.register(contribution, plugin.id);
          any = true;
        } catch {
          // A built-in or taken name: the runtime refuses it at install; the builder skips it.
        }
      }
    }
    return any ? registry : undefined;
  }

  /** The page's plugins, then this element's own. */
  private allPlugins(): FormPlugin[] {
    return [...this.pluginRegistryValue.plugins(), ...this.pluginsValue];
  }

  /** The catalogue the builder edits with: the standard one, the plugins' definitions, the element's own. */
  private mergedDefinitions(): ComponentDefinition[] {
    return mergeComponentDefinitions(this.componentDefinitionsValue, pluginComponents(this.allPlugins()));
  }

  /**
   * The palette: the standard entries, the plugins' (`ComponentDefinition.palette`), then
   * the element's own `componentTypes` — one entry per type, a later one replacing an
   * earlier one's label and group in place — under the `component-types` filter.
   */
  private paletteTypes(): DatumBuilderComponentType[] {
    const byType = new Map<string, DatumBuilderComponentType>();
    for (const entry of [...standardComponentTypes(), ...paletteEntriesOf(pluginComponents(this.allPlugins())), ...this.componentTypesValue]) {
      byType.set(entry.type, entry);
    }
    return [...byType.values()].filter((entry) => matchesTypeFilter(entry.type, this.componentTypesFilter));
  }

  /** The page's data sources with the plugins' behind them, for the canvas and the picker. */
  private previewDataSources(): DataSourceSet | undefined {
    return withPluginDataSources(this.dataSourcesValue, this.allPlugins());
  }

  public attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    try {
      // A module attribute naming another origin is as good as absent (see attributeOriginProblem).
      if (name in ORIGIN_BOUND_ATTRIBUTES) {
        this.seenUrlAttributes.add(name);
      }
      // A module URL is resolved once, here: the origin check judges the absolute URL, and the
      // element stores and later loads that same URL, whatever the page's base becomes.
      if (value !== null && (name === "wasm" || name === "pdf" || name === "pdf-pages")) {
        value = absoluteModuleAttribute(value);
      }
      if (value !== null && name in ORIGIN_BOUND_ATTRIBUTES && !this.originAllows(name, value)) {
        value = null;
      }
      switch (name) {
        case "allow-origins":
          this.allowOriginsChanged(value);
          break;
        case "definition":
          this.definition = value === null ? undefined : toFormDefinition(parseJsonAttribute("definition", value));
          break;
        case "src":
          this.src = value ?? undefined;
          break;
        case "max-definition-bytes":
          this.maxDefinitionBytes = value === null ? undefined : toDefinitionByteLimit(value);
          break;
        case "theme":
          this.theme = value ?? undefined;
          break;
        case "load-fonts":
          this.loadFonts = value !== null;
          break;
        case "debug":
          this.debugValue = value !== null;
          break;
        case "pdf-theme":
          this.pdfTheme = value ?? undefined;
          break;
        case "layout":
          // Straight to the field: the setter reflects to this attribute, which would re-enter here.
          this.layoutValue = value === "contained" ? "contained" : "page";
          this.request("layout");
          break;
        case "locale":
          this.locale = value ?? undefined;
          break;
        case "data-sources":
          this.dataSources = value === null ? undefined : parseJsonAttribute("data-sources", value);
          break;
        case "data-source-ids":
          this.dataSourceIds = parseList(value);
          break;
        case "validation-codes":
          this.validationCodes = parseList(value);
          break;
        case "component-types":
          this.componentTypeFilter = value === null ? undefined : parseList(value);
          break;
        case "pdf":
          this.pdf = value ?? undefined;
          break;
        case "wasm":
          this.wasm = value ?? undefined;
          break;
        case "pdf-pages":
          this.pdfPages = value ?? undefined;
          break;
        case "journeys":
          this.journeys = value ?? undefined;
          break;
        case "values":
          this.values = value === null ? {} : parseJsonAttribute("values", value);
          break;
        case "translations":
          this.translations = value === null ? undefined : parseJsonAttribute("translations", value);
          break;
        case "workspace":
          // Straight to the field, as for mode: the builder's change event reflects back to this attribute.
          this.workspaceValue = this.allowedWorkspace((value ?? undefined) as BuilderWorkspace | undefined);
          value = this.workspaceValue ?? null;
          // Journeys or PDF while its mode's chunk is coming: entered once the mode registers.
          this.pendingDesignerWorkspace = this.builderEl && value && this.designerLoading(value) ? (value as BuilderWorkspace) : undefined;
          if (this.pendingDesignerWorkspace) {
            break;
          }
          if (this.builderEl && value && this.builderEl.workspace !== value) {
            this.builderEl.setAttribute("workspace", value);
          }
          break;
        case "hidden-workspaces":
          this.hiddenWorkspaces = (value ?? "").split(/[\s,]+/).filter(Boolean) as BuilderWorkspace[];
          break;
        case "workspaces":
          this.applyWorkspaces(value);
          break;
        case "layout-id":
          this.layoutId = value ?? undefined;
          break;
        case "hidden-panels":
          this.hiddenPanels = (value ?? "").split(/[\s,]+/).filter(Boolean);
          break;
        case "managed-settings":
          this.managedSettings = (value ?? "").split(/[\s,]+/).filter(Boolean);
          break;
        case "features": {
          // Left out rather than read as "everything": a typo can only narrow what exists, so say which word it was.
          const unknown = unknownBuilderFeatureTokens(value);
          if (unknown.length > 0) {
            reportError(this, "features.unknown", `features names no such feature or preset: ${unknown.map((word) => `"${word}"`).join(", ")}`);
          }
          this.applyFeatures(value === null ? undefined : parseBuilderFeatures(value), value);
          break;
        }
        case "full-window":
        case "no-full-window":
          // The inner builder owns both; its change event reflects full-window back here.
          this.builderEl?.toggleAttribute(name, value !== null);
          break;
        case "scheme":
          // The inner builder owns the scheme; its change event reflects it back here.
          if (this.reflectingScheme) {
            break;
          }
          this.schemeAttributeReflected = false;
          if (value === null) {
            // Back to the remembered choice: the inner reads its memory, and says so if that changes the look.
            this.forwardingSchemeRemoval = true;
            try {
              this.builderEl?.removeAttribute("scheme");
            } finally {
              this.forwardingSchemeRemoval = false;
            }
          } else {
            this.builderEl?.setAttribute("scheme", value);
          }
          break;
        case "no-scheme-toggle":
          this.builderEl?.toggleAttribute(name, value !== null);
          break;
        case "leave-guard":
          // Read when the page is about to go (onBeforeUnload): nothing to apply here.
          break;
        case "mode":
          // Straight to the field: the setter reflects to this attribute, which would re-enter here.
          this.modeValue = value ?? undefined;
          this.request("mode");
          break;
        case "persist-panels":
          this.persistPanelsValue = value ?? undefined;
          if (this.builderEl) {
            this.builderEl.persistPanels = this.persistPanelsValue;
          }
          break;
        case "file-actions":
          this.fileActionsNamed = parseFileActions(value);
          this.syncFileActions();
          break;
        case "save":
          this.save = value ?? false;
          break;
        case "save-method":
          this.saveMethod = value ?? undefined;
          break;
        case "save-label":
          this.saveLabel = value ?? undefined;
          break;
        default:
          break;
      }
    } catch (error) {
      // As on the form: a parser that knows its cause says so, any other refused value is `attribute.invalid`.
      reportError(this, codeOf(error, name === "definition" ? "definition.invalid" : "attribute.invalid"), error instanceof Error ? error.message : String(error), error);
    }
  }

  // --- configuration -----------------------------------------------------

  /**
   * The form being edited. Reading returns it as authored so far — the current tree, the
   * localization the builder committed, the PDF layouts as designed and the journeys as built,
   * under the identity of whatever was assigned. Assigning seeds the builder anew (undo history
   * and selection are dropped, on every side); `undefined` starts an empty form.
   */
  public get definition(): FormDefinition {
    return this.composeDefinition();
  }

  /**
   * The definition as authored, from every side; `pdf`, when given, stands in for the PDF
   * side's block (the saved baseline's declared layouts, see {@link loadBaselineSignature}).
   */
  private composeDefinition(pdfAsLoaded?: PdfConfiguration): FormDefinition {
    const builder = this.builderEl;
    if (!builder) {
      return this.seed;
    }
    // The seed's keys in the seed's order, each side's own written over it in place — a key the
    // seed lacked goes last — so a definition read back before anything is edited is the one
    // given, byte for byte, and a host saving it on load writes no spurious diff.
    // The identity as authored on the Form panel's Identity section, over whatever else the
    // seed carried (metadata, accessibility) that the builder does not edit.
    const definition: FormDefinition = { ...this.seed, ...(builder.identity ?? {}), root: builder.value };
    // A definition handed over without an identity (or with one that is not text) reads back with
    // the default one, as the attribute and `src` routes fill it, never as a blank id.
    for (const key of ["id", "version", "schemaVersion"] as const) {
      if (typeof definition[key] !== "string") {
        definition[key] = DEFAULT_FORM_IDENTITY[key];
      }
    }
    const localization = builder.localization;
    if (localization) {
      // The seed's own object while the builder holds the same locales, which it may keep with
      // their keys in another order.
      definition.localization = this.seed.localization && sameData(localization, this.seed.localization) ? this.seed.localization : localization;
    } else {
      delete definition.localization;
    }
    // The form's translations: the seed's own object while the builder holds the same
    // map, and nothing once the last language is removed, as the localization goes with it.
    const translations = builder.controller.translations();
    if (translations) {
      definition.translations = this.seed.translations && sameData(translations, this.seed.translations) ? this.seed.translations : translations;
    } else {
      delete definition.translations;
    }
    // The form's `kinds` map: the engine type each plugin or binding type it uses reads
    // as, so validation, the sandbox and the PDF treat a `gcds-date` as a date with none of the
    // binding's code. The seed's own object while nothing changes it.
    const kinds = builder.controller.definitionKinds(this.seed.kinds);
    if (kinds) {
      definition.kinds = kinds;
    } else {
      delete definition.kinds;
    }
    const pdf = pdfAsLoaded ?? this.pdfModeValue?.pdfConfiguration ?? this.seed.pdf;
    // No layout, no block: a host prints such a form from the form itself.
    if (pdf && (pdf.layouts?.length ?? 0) > 0) {
      definition.pdf = pdf;
    } else {
      delete definition.pdf;
    }
    // The form's scenarios: the seed's own object while the builder holds the same
    // block, and nothing once they are all removed, as the localization goes with its last locale.
    const tests = builder.tests;
    if (tests) {
      definition.tests = this.seed.tests && sameData(tests, this.seed.tests) ? this.seed.tests : tests;
    } else {
      delete definition.tests;
    }
    // The Journeys side's block once it is on: the seed's own object until a journey is edited,
    // and nothing once the journeys are edited down to none — never the seed's again.
    const journey = this.journeyModeValue ? this.journeyModeValue.journeyConfiguration : this.seed.journey;
    if (journey !== undefined) {
      definition.journey = journey;
    } else {
      delete definition.journey;
    }
    return definition;
  }

  public set definition(value: FormDefinition | undefined) {
    // One source at a time: while a `src` fetch is on its way an assigned form is refused, so
    // which of the two the author ends up editing never depends on which arrived last.
    if (value !== undefined && this.srcLoading) {
      reportError(this, "definition.source-conflict", `The form was not loaded: ${this.srcLoadingWords()}; set src to nothing first to assign a definition in its place.`);
      return;
    }
    if (this.takeDefinition(value)) {
      this.definitionAssigned = value !== undefined;
    }
  }

  /** The words for a `src` fetch still on its way. */
  private srcLoadingWords(): string {
    return `the form from src (${this.srcValue ?? ""}) is still loading`;
  }

  /** Open and New wait for a `src` fetch on its way, as an assigned definition does. */
  private refuseWhileSrcLoads(): void {
    if (this.srcLoading) {
      throw new Error(this.srcLoadingWords());
    }
  }

  /**
   * The longest definition read from `src` or Open, in UTF-8 bytes (2 MiB unless set): a larger
   * one is refused before it is parsed, as `max-definition-bytes`. `undefined` puts the 2 MiB back.
   */
  public get maxDefinitionBytes(): number {
    return this.maxDefinitionBytesValue;
  }

  public set maxDefinitionBytes(value: number | undefined) {
    if (value !== undefined && !isDefinitionByteLimit(value)) {
      reportError(this, "max-definition-bytes.invalid", `maxDefinitionBytes must be a whole number of bytes above 0, not ${String(value)}`);
      return;
    }
    this.maxDefinitionBytesValue = value ?? MAX_DEFINITION_BYTES;
    // The bar's own Open measures the file against the same cap before it reads any of it.
    if (this.builderEl) {
      this.builderEl.maxDefinitionBytes = this.maxDefinitionBytesValue;
    }
  }

  /** Seeds the builder with `value` for whichever route brought it; `false` when it is refused. */
  private takeDefinition(value: FormDefinition | undefined): boolean {
    // The tree check of Open, on every route a definition arrives by (this setter, the `definition`
    // attribute, `src`, a host's glue): one the builder cannot take is reported as a
    // `datum-error` and the form as it stands stays, the seed untouched. The sides are not part of it: a layout or a journey it cannot use leaves that side out.
    if (value !== undefined) {
      const problem = this.refusal(() => definitionTreeProblem(value));
      if (problem) {
        reportError(this, "definition.invalid", `The form was not loaded: ${problem}`);
        return false;
      }
    }
    this.seedBeforeReplace ??= this.seed;
    this.seed = value ?? { ...DEFAULT_FORM_IDENTITY, root: startingFormRoot() };
    // A header or footer part that cannot key a translation loads (it is drawn in the form's own
    // language) and is told, once, with how it is put right.
    const chrome = value === undefined ? undefined : this.refusal(() => chromePartProblem(value));
    if (chrome) {
      reportError(this, "chrome.untranslated", `The form was loaded, but ${chrome}: it is shown untranslated until the Header & footer panel gives it an id, which its first edit does.`);
    }
    // Told once the builder has taken the form (see flush): a form it then refuses was never loaded.
    this.heldLoadWarning = value === undefined ? undefined : this.droppedTranslationsWarning(value);
    // The definition a page loads is the saved one until it says otherwise.
    this.baselinePending = true;
    this.request("options");
    return true;
  }

  /**
   * Whether a module attribute may use `value`; a refusal is reported and remembered, so a later
   * `allow-origins` that lists the origin takes the attribute after all.
   */
  private originAllows(name: string, value: string): boolean {
    const problem = this.originProblem(name, value);
    if (problem === undefined) {
      this.refusedUrlAttributes.delete(name);
      return true;
    }
    this.refusedUrlAttributes.add(name);
    reportError(this, "attribute.origin-refused", problem);
    return false;
  }

  private originProblem(name: string, value: string): string | undefined {
    let url: string | undefined;
    try {
      url = moduleAttributeUrl(value);
    } catch (error) {
      return `The ${name} attribute was not used: ${error instanceof Error ? error.message : String(error)}`;
    }
    return url === undefined ? undefined : attributeOriginProblem(this, name, ORIGIN_BOUND_ATTRIBUTES[name]!, url);
  }

  /** A new `allow-origins`: each module attribute whose verdict it changes is applied again (or dropped). */
  private allowOriginsChanged(value: string | null): void {
    const problem = allowOriginsProblem(value);
    if (problem) {
      reportError(this, "allow-origins.invalid", problem);
    }
    for (const name of Object.keys(ORIGIN_BOUND_ATTRIBUTES)) {
      const current = this.getAttribute(name);
      if (current === null || !this.seenUrlAttributes.has(name) || this.refusedUrlAttributes.has(name) === (this.originProblem(name, current) !== undefined)) {
        continue;
      }
      this.attributeChangedCallback(name, current, current);
    }
  }

  /**
   * The warning for the translation entries the builder leaves out of a form it loads (a text
   * that is not text, an entry without its source, an unknown kind, a key that cannot be a
   * property), told once the builder has taken the form: it loads, and what Save writes is the
   * rest, so the page hears how many and where the first few were before they are gone from the file.
   */
  private droppedTranslationsWarning(definition: FormDefinition): DatumWarningDetail | undefined {
    let dropped: { count: number; first: string[][] };
    try {
      ({ dropped } = readFormTranslationsReport(definition.translations, supportedLocaleCodes(definition.localization)));
    } catch {
      return undefined;
    }
    if (dropped.count === 0) {
      return undefined;
    }
    const addresses = dropped.first.map((path) => (path.length === 0 ? "translations" : path.join(".")));
    const more = dropped.count > addresses.length ? `, and ${dropped.count - addresses.length} more` : "";
    const entries = dropped.count === 1 ? "1 translation entry was" : `${dropped.count} translation entries were`;
    return {
      code: "translations.dropped",
      count: dropped.count,
      addresses,
      message: `The form was loaded, but ${entries} left out as unusable (${addresses.join(", ")}${more}): saving the form keeps only the others.`
    };
  }

  /** What `check` finds wrong, a throw from it counted as a finding: a value the checks cannot read is not one to take. */
  private refusal(check: () => string | undefined): string | undefined {
    try {
      return check();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Whether the definition differs from the saved one (the one loaded, or the last `markSaved()`). */
  public get dirty(): boolean {
    return this.dirtyValue;
  }

  /**
   * Tells the builder the host has saved: the definition as it stands is the new baseline, and
   * so are its languages (a host keeping a translation catalog has applied `localeChangesSinceSave()` by now).
   */
  public markSaved(): void {
    this.builderEl?.markLocalesSaved();
    this.savedSignature = JSON.stringify(this.definition);
    this.baselinePending = false;
    this.baselineFromLoad = false;
    this.updateDirty();
  }

  /** The definition as the host last saved it (the one loaded, or the last `markSaved()`); `dirty` compares with it. */
  public get savedDefinition(): FormDefinition | undefined {
    if (this.savedSignature === undefined) {
      return undefined;
    }
    if (this.savedParsed?.signature !== this.savedSignature) {
      this.savedParsed = { signature: this.savedSignature, definition: JSON.parse(this.savedSignature) as FormDefinition };
    }
    return this.savedParsed.definition;
  }

  /** The definition as the host last saved it, for a host that keeps it apart from what it loaded. */
  public set savedDefinition(value: FormDefinition | undefined) {
    this.savedSignature = value === undefined ? undefined : JSON.stringify(value);
    this.baselinePending = value === undefined;
    this.baselineFromLoad = false;
    this.updateDirty();
  }

  private updateDirty(): void {
    // A draft held outside the tree counts, as it does for hasUnsavedChanges(): the definition
    // omits it, so a host gating Save on `dirty` would otherwise see a clean form.
    const dirty = this.savedSignature !== undefined && (JSON.stringify(this.definition) !== this.savedSignature || this.hasUnsavedChanges());
    // A phone's menu drawer says whether the form is saved.
    const builder = this.root?.querySelector("datum-builder") as DatumBuilderElement | null;
    if (builder) {
      builder.saveState = this.savedSignature === undefined ? undefined : dirty ? "unsaved" : "saved";
    }
    if (dirty === this.dirtyValue) {
      return;
    }
    this.dirtyValue = dirty;
    this.toggleAttribute("dirty", dirty);
    emit<DatumFormBuilderDirtyChangeDetail>(this, "datum-builder-dirty-change", { dirty });
  }

  /** Shows the Download's warnings above the builder, or puts the notice away when there are none. */
  private showFileWarnings(warnings: readonly DatumFormBuilderFileWarning[]): void {
    const box = this.root.querySelector<HTMLElement>("[data-file-warning]");
    const text = box?.querySelector<HTMLElement>("[data-file-warning-message]");
    if (!box || !text) {
      return;
    }
    // Hidden first and shown after the words are in: a polite status region reads what it gains.
    box.hidden = true;
    text.textContent = warnings.map((warning) => warning.message).join(" ");
    box.hidden = warnings.length === 0;
  }

  /**
   * After every change: the saved baseline (set from the first seeding of a loaded definition),
   * the dirty flag, and — once the page is idle — the problems counted on the Journeys and PDF tabs
   * The journey diagnostics are a lazy chunk; nothing waits on them.
   */
  private afterChange(reason: string): void {
    if (this.baselinePending && reason === "init") {
      this.savedSignature = this.loadBaselineSignature();
      this.baselinePending = false;
      this.baselineFromLoad = true;
      this.editedSinceBaseline = false;
    } else if (reason !== "init" && reason !== "select" && reason !== "preview") {
      this.editedSinceBaseline = true;
      if (this.srcLoading) {
        this.editedWhileSrcLoads = true;
      }
    }
    this.updateDirty();
    if (this.diagnosticsTimer !== undefined) {
      clearTimeout(this.diagnosticsTimer);
    }
    this.diagnosticsTimer = setTimeout(() => {
      this.diagnosticsTimer = undefined;
      const idle = (globalThis as { requestIdleCallback?: (callback: () => void) => void }).requestIdleCallback;
      (idle ?? ((callback: () => void) => callback()))(() => {
        this.countPdfProblems();
        void this.countJourneyProblems();
      });
    }, 250);
  }

  /** Whether the host has heard that the journey diagnostics would not load, since the last time they did. */
  private journeyCountReported = false;

  private async countJourneyProblems(): Promise<void> {
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    const definition = this.definition;
    let count = 0;
    // The journeys' diagnostics are a chunk of the Journeys feature: none is fetched without it.
    if (definition.journey !== undefined && this.featureEnabled("journeys")) {
      try {
        const diagnose = await loadJourneyDiagnostics();
        count = diagnose(definition).filter((finding) => finding.severity === "error").length;
      } catch (cause) {
        // The chunk did not load: no count (the Journeys overview says "Couldn't check"), the
        // next change tries again, and the host hears it once per burst, not per change.
        if (!this.journeyCountReported) {
          this.journeyCountReported = true;
          reportError(this, "file.unavailable", "The journeys' problem count could not be worked out because their diagnostics did not load", cause);
        }
        // An earlier success left a number on the tab; it no longer describes the definition,
        // so the badge goes rather than showing a stale count as if it were current.
        if ("journeys" in builder.workspaceProblems) {
          const { journeys: _stale, ...rest } = builder.workspaceProblems;
          builder.workspaceProblems = rest;
        }
        return;
      }
      this.journeyCountReported = false;
    }
    if ((builder.workspaceProblems.journeys ?? 0) !== count) {
      builder.workspaceProblems = { ...builder.workspaceProblems, journeys: count };
    }
  }

  /** The PDF tab's count: the layouts' rule problems, as the PDF overview lists them. */
  private countPdfProblems(): void {
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    const definition = this.definition;
    const locale = declaredDefaultLocale(definition.localization) ?? "en";
    const count = definition.pdf && this.featureEnabled("pdf") ? pdfLayoutConditionFindings({ formRoot: definition.root, locale }, definition.pdf).length : 0;
    if ((builder.workspaceProblems.pdf ?? 0) !== count) {
      builder.workspaceProblems = { ...builder.workspaceProblems, pdf: count };
    }
  }

  /**
   * A URL to load the definition from (JSON), resolved against the page. Refused (a
   * `datum-error`, nothing fetched) while a definition the page assigned, or one the author
   * brought by New or Open, is in place: clear `definition` first. A later `src` replaces a form
   * an earlier one brought. A response that arrives after the author edited the form is not
   * loaded over the edits: it is dropped and told as a `datum-warning` (`src.superseded`).
   */
  public get src(): string | undefined {
    return this.srcValue;
  }

  public set src(value: string | undefined) {
    if (value !== undefined && this.definitionAssigned) {
      reportError(this, "definition.source-conflict", `The form was not loaded from src (${value}): a definition is assigned to this builder (by the page, or by New or Open); set definition to nothing first to load one from src.`);
      return;
    }
    this.srcValue = value;
    if (value === undefined) {
      this.srcToken += 1;
      this.srcLoading = false;
      return;
    }
    this.loadSrc(value);
  }

  /** The shell's own `"builder"`-target theme: `"default"`, a registered id, or a theme object. */
  public get theme(): BuilderThemeInput {
    return this.themeValue;
  }

  public set theme(value: BuilderThemeInput) {
    this.themeValue = value;
    this.request("theme");
  }

  /**
   * The design-system binding the canvas draws the form with: a `LiveBinding`, the id of one
   * registered on the page (`bindings.register`), or nothing for Datum's own. The canvas's
   * picker offers the registered bindings beside it.
   */
  public get binding(): LiveBinding | string | undefined {
    return this.bindingValue;
  }

  public set binding(value: LiveBinding | string | undefined) {
    this.bindingValue = value;
    this.request("preview");
  }

  /** The design system's files as the host serves them, for a binding that needs them. */
  public get assets(): LiveAssets | undefined {
    return this.assetsValue;
  }

  public set assets(value: LiveAssets | undefined) {
    this.assetsValue = value;
    this.request("preview");
  }

  /**
   * Whether the element links the builder's own faces (the studio look's fonts) into the page
   * — the `load-fonts` attribute. The canvas form's files are not part of it: a binding's
   * files come through {@link assets}.
   */
  public get loadFonts(): boolean {
    return this.loadFontsValue;
  }

  public set loadFonts(value: boolean) {
    this.loadFontsValue = value;
    this.request("preview");
  }

  /** See `DatumBuilderLayout`: `"page"` (window-pinned chrome) or `"contained"` (inside this element's box). */
  public get layout(): DatumBuilderLayout {
    return this.layoutValue;
  }

  public set layout(value: DatumBuilderLayout) {
    this.layoutValue = value;
    // Reflected, so the companion stylesheet and the page's own CSS can key on it — and only
    // when it differs, since the attribute callback lands back here.
    if (value === "contained" && this.getAttribute("layout") !== "contained") {
      this.setAttribute("layout", "contained");
    } else if (value !== "contained" && this.hasAttribute("layout")) {
      this.removeAttribute("layout");
    }
    this.request("layout");
  }

  /** The locale the canvas and inspector resolve labels in. */
  public get locale(): string | undefined {
    return this.localeValue;
  }

  public set locale(value: string | undefined) {
    this.localeValue = value;
    this.request("locale");
  }

  /** Data sources the canvas previews and the inspector's Data source picker lists (what `defineDataSources` takes, or a set). */
  public get dataSources(): DataSourceSet | undefined {
    return this.dataSourcesValue;
  }

  public set dataSources(value: DatumFormDataSources | undefined) {
    this.dataSourcesValue = value === undefined ? undefined : isDataSourceSet(value) ? value : defineDataSources(value);
    this.request("preview");
  }

  /** Further source ids for the picker — ones the rendering page resolves itself. */
  public get dataSourceIds(): string[] {
    return this.dataSourceIdsValue;
  }

  public set dataSourceIds(value: string[]) {
    this.dataSourceIdsValue = value;
    this.request("preview");
  }

  /**
   * Validation codes the page knows beyond the engine's own — the keys of its `messages`
   * catalog, what its server or rules return — offered in the messages editor.
   * The `validation-codes` attribute takes a comma-separated list; the property also takes
   * `{ code, label }` entries for a hint on hover.
   */
  public get validationCodes(): HostValidationCode[] {
    return this.validationCodesValue;
  }

  public set validationCodes(value: HostValidationCode[]) {
    this.validationCodesValue = value;
    this.request("preview");
  }

  /**
   * Restricts the palette (standard and custom types alike); `undefined` offers every type.
   * An entry names a type to keep, or with a leading `-` a type to drop; a trailing `*`
   * matches a prefix, so `["-acme-*"]` offers everything but a plugin's acme types and
   * `["text", "select"]` offers those two alone. Exclusions win over inclusions.
   */
  public get componentTypeFilter(): string[] | undefined {
    return this.componentTypesFilter;
  }

  public set componentTypeFilter(value: string[] | undefined) {
    this.componentTypesFilter = value;
    this.request("options");
  }

  /** Palette entries for custom component types, appended to the standard palette. */
  public get componentTypes(): DatumBuilderComponentType[] {
    return this.componentTypesValue;
  }

  public set componentTypes(value: DatumBuilderComponentType[]) {
    this.componentTypesValue = value;
    this.request("options");
  }

  /** Component types beyond the standard catalogue (a type matching a standard one replaces it). */
  public get componentDefinitions(): ComponentDefinition[] {
    return this.componentDefinitionsValue;
  }

  public set componentDefinitions(value: ComponentDefinition[]) {
    this.componentDefinitionsValue = value;
    this.request("options");
  }

  /**
   * Plugins for this builder alone, beside those the page registered with
   * `plugins.register`: their components join the catalogue and, through the palette entry
   * each declares, the palette; their data sources the canvas and the picker; the rest
   * (validators, hooks, handlers, renditions, sandbox modules) the previews' runtime. A
   * property only. Assigning reseeds the builder, as `componentDefinitions` does.
   */
  public get plugins(): FormPlugin[] {
    return this.pluginsValue;
  }

  public set plugins(value: FormPlugin[]) {
    this.pluginsValue = value;
    this.request("options");
  }

  // --- the PDF side ---------------------------------------------------------

  /**
   * The PDF side. Absent (or `"auto"`): on, with the executor fetched as a chunk of this bundle
   * on the first preview, test fill or inspection. `"off"`: no PDF mode at all. A URL: on, with
   * the executor loaded from that module instead (see `<datum-form pdf>`).
   */
  public get pdf(): string | undefined {
    return this.pdfValue;
  }

  public set pdf(value: string | undefined) {
    this.pdfValue = value;
    this.request("pdf");
  }

  /**
   * Where the page imagery for template areas comes from. Absent (or `"auto"`):
   * with the executor — the chunk of this bundle, or `datum-pdf-pages.js` beside the module
   * `pdf` names. `"off"`: none; the area editor draws on blank sheets. A URL: that module.
   */
  public get pdfPages(): string | undefined {
    return this.pdfPagesValue;
  }

  public set pdfPages(value: string | undefined) {
    this.pdfPagesValue = value;
    this.request("pdf");
  }

  /** The executor in use, for a page that built one itself (the QuickJS-WASM sandbox, a server). */
  public get pdfSupport(): PdfBuilderModeSupport | undefined {
    return this.pdfSupportValue;
  }

  public set pdfSupport(value: PdfBuilderModeSupport | undefined) {
    this.pdfSupportValue = value;
    this.request("pdf");
  }

  /**
   * The `"pdf"`-target theme the PDF side's previews and downloads render under: `"default"`,
   * a registered id (`"acme"`), or a theme object. A layout that names its own theme keeps it.
   */
  public get pdfTheme(): PdfThemeInput {
    return this.pdfThemeValue;
  }

  public set pdfTheme(value: PdfThemeInput) {
    this.pdfThemeValue = value;
    this.request("pdf");
  }

  /** The host's template resolver: a populated form's PDF from the source it names, and the PDFs offered to authors. */
  public get pdfTemplates(): PdfTemplateResolver | undefined {
    return this.pdfTemplatesValue;
  }

  public set pdfTemplates(value: PdfTemplateResolver | undefined) {
    this.pdfTemplatesValue = value;
  }

  /**
   * The icon set the builder's chrome draws with. Unset, the default: whatever the
   * page registered with `setDefaultIconSet` before the element upgraded — an icon package's
   * bundle registers its set on load — else the engine's
   * own drawings. Setting it repaints the chrome in place.
   */
  public get icons(): IconSet | undefined {
    return this.iconsValue;
  }

  public set icons(value: IconSet | undefined) {
    this.iconsValue = value;
    if (this.builderEl) {
      this.builderEl.icons = value;
    }
  }

  /**
   * The plugin formula functions the host wired: its `pluginPlatform.formulaFunctions`
   * registry, or anything with a `table()` and `signatures()`. The Logic editor, the
   * inspector, the Form panel and the Variables panel list them with the built-ins.
   */
  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.formulaFunctionsValue;
  }

  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    this.formulaFunctionsValue = value;
    if (this.builderEl) {
      this.builderEl.formulaFunctions = this.wiredFormulaFunctions();
    }
  }

  /** Where the "Formula reference" links go; unset: no link is drawn anywhere. */
  public get formulaReferenceHref(): string | undefined {
    return this.formulaReferenceHrefValue;
  }

  public set formulaReferenceHref(value: string | undefined) {
    this.formulaReferenceHrefValue = value;
    if (this.builderEl) {
      this.builderEl.formulaReferenceHref = value;
    }
  }

  /** The print theme Try it's Print and the Print workspace draw with, as `<datum-form>` takes it; unset, the basic one. */
  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
    if (this.builderEl) {
      this.builderEl.printTheme = value;
    }
  }

  /** The builder's own language for its words (the text catalog's locale), not the form's. */
  public get textLocale(): string | undefined {
    return this.textLocaleValue;
  }

  public set textLocale(value: string | undefined) {
    this.textLocaleValue = value;
    if (this.builderEl) {
      this.builderEl.textLocale = value;
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public get textCatalog(): DatumBuilderElement["textCatalog"] {
    return this.textCatalogValue;
  }

  public set textCatalog(value: DatumBuilderElement["textCatalog"]) {
    this.textCatalogValue = value;
    if (this.builderEl) {
      this.builderEl.textCatalog = value;
    }
  }

  /** Sample answers the PDF side previews and prints, keyed by value path. */
  public get values(): Record<string, unknown> {
    return this.valuesValue;
  }

  public set values(value: Record<string, unknown>) {
    this.valuesValue = value;
  }

  /**
   * The host's translation catalog: locale, then kind, then the owner's id, then the
   * property tree, with string leaves. An entry overrides the form's own translation of the same
   * address, in the previews and in the Languages workspace (where the cell is read-only).
   */
  public get translations(): TranslationCatalog | undefined {
    return this.translationsValue;
  }

  public set translations(value: TranslationCatalog | undefined) {
    this.translationsValue = value;
    if (this.builderEl) {
      this.builderEl.translationsSource = this.wiredTranslationsSource();
    }
  }

  /** The inner builder's feed of the host catalog: asked whenever it needs the catalog, so a later assignment is seen. */
  private wiredTranslationsSource(): DatumBuilderElement["translationsSource"] {
    return this.translationsValue === undefined ? undefined : () => ({ catalog: this.translationsValue ?? {} });
  }

  /** The PDF mode, once the PDF side is set up: its catalog API (`layouts`, `newLayout`, `selectLayout`, `renderPdf`, …). */
  public get pdfMode(): PdfBuilderMode | undefined {
    return this.pdfModeValue;
  }

  /** The definition's `pdf` block as edited. Assigning replaces the layouts. */
  public get pdfConfiguration(): PdfConfiguration | undefined {
    return this.pdfModeValue?.pdfConfiguration ?? this.seed.pdf;
  }

  public set pdfConfiguration(value: PdfConfiguration | undefined) {
    // As Open takes a `pdf` block: a shape it refuses, or a count past a cap, is reported and the layouts stay as they are.
    const problem = this.refusal(() => pdfConfigurationProblem(this.seed, value));
    if (problem) {
      reportError(this, "pdf.layouts-invalid", `The PDF layouts were not loaded: ${problem}`);
      return;
    }
    // `null` drops the layouts, as `undefined` does.
    const layouts = value ?? undefined;
    this.seed = layouts ? { ...this.seed, pdf: layouts } : (({ pdf: _dropped, ...rest }) => rest)(this.seed);
    if (this.pdfModeValue) {
      this.pdfModeValue.pdfConfiguration = layouts ?? { layouts: [] };
    }
  }

  // --- the journeys ---------------------------------------------

  /**
   * The Journeys side. Absent (or `"auto"`): on — each of the definition's journeys a document
   * in the dropdown under "Journeys", the `+` making one from the form, and the Form panel an
   * "Opens as" row while the form has one; its designer is a chunk of this bundle, loaded when
   * the side is first opened. `"off"`: no Journeys side; the definition's journeys, with any
   * edits made while it was on, pass through as they are.
   */
  public get journeys(): string | undefined {
    return this.journeysValue;
  }

  public set journeys(value: string | undefined) {
    this.journeysValue = value;
    this.request("journeys");
  }

  /** The Journeys mode, once the side is set up: its catalog API (`journeys`, `newJourney`, `selectJourney`, `setOpensAs`, …). */
  public get journeyMode(): JourneyBuilderMode | undefined {
    return this.journeyModeValue;
  }

  /**
   * The definition's `journey` block as edited: the one given, as given, until a journey is
   * edited; `undefined` once the journeys are edited down to none. Assigning replaces the
   * journeys (every journey's undo history with them), leaving the form as it is.
   */
  public get journeyConfiguration(): JourneyConfiguration | undefined {
    return this.journeyModeValue ? this.journeyModeValue.journeyConfiguration : this.seed.journey;
  }

  public set journeyConfiguration(value: JourneyConfiguration | undefined) {
    // As Open takes a `journey` block: a shape it refuses, or a count past a cap, is reported and the journeys stay as they are.
    const problem = this.refusal(() => journeyConfigurationProblem(this.seed, value));
    if (problem) {
      reportError(this, "journeys.invalid", `The journeys were not loaded: ${problem}`);
      return;
    }
    // `null` drops the journeys, as `undefined` does.
    const journeys = value ?? undefined;
    this.seed = withJourney(this.seed, journeys);
    this.journeyModeValue?.reseed(journeys);
  }

  /** The workspace on the page: `"form"`, `"logic"`, `"data"`, `"languages"`, `"journeys"`, `"pdf"` or `"print"`. Assigning switches, through the unsaved-edits guard. */
  public get workspace(): BuilderWorkspace {
    return this.builderEl?.workspace ?? this.workspaceValue ?? "form";
  }

  public set workspace(value: BuilderWorkspace) {
    this.workspaceValue = value;
    if (this.getAttribute("workspace") !== value) {
      this.setAttribute("workspace", value);
    }
  }

  /**
   * Switches workspaces now; returns whether the switch started (a held unsaved-edits prompt means
   * not yet). Journeys or PDF asked for while that mode's chunk is still coming is
   * entered once the mode registers, and counts as started; a side that is off or hidden is
   * refused, as before.
   */
  public setWorkspace(id: BuilderWorkspace): boolean {
    this.workspaceValue = id;
    // A workspace asked for now wins over a side asked for while its chunk was coming.
    this.pendingDesignerMode = undefined;
    if (this.builderEl && this.designerLoading(id)) {
      this.pendingDesignerWorkspace = id;
      return true;
    }
    this.pendingDesignerWorkspace = undefined;
    return this.builderEl ? this.builderEl.setWorkspace(id) : true;
  }

  /** Whether the builder covers the whole browser window (`full-window`); the bar's button toggles it unless `no-full-window`. */
  public get fullWindow(): boolean {
    return this.hasAttribute("full-window");
  }

  public set fullWindow(value: boolean) {
    this.toggleAttribute("full-window", value);
  }

  /** The inner builder's scheme on this element's attribute, without sending it back in. */
  private reflectScheme(scheme: "light" | "dark"): void {
    this.reflectingScheme = true;
    try {
      this.setAttribute("scheme", scheme);
      this.schemeAttributeReflected = true;
    } finally {
      this.reflectingScheme = false;
    }
  }

  /**
   * This element's own shadow root (the chunk status card, the Download notice, an assistant's
   * banner) sits outside the inner builder's hosts, so it sees no --db-* token: while the
   * builder is dark the few it reads, and `color-scheme`, go on this host inline, copied from
   * the inner builder's own. In light nothing is written and each
   * keeps its fallback.
   */
  private syncSchemeLook(): void {
    const builder = this.builderEl;
    const dark = builder?.scheme === "dark";
    if (!dark && !this.schemeLookApplied) {
      return;
    }
    const names = [...SCHEME_LOOK_TOKENS, "color-scheme"];
    if (dark && !this.schemeLookApplied) {
      // Whatever the page set inline on this host is its own: held now, given back in light.
      this.heldSchemeLook.clear();
      for (const name of names) {
        const own = this.style.getPropertyValue(name);
        if (own) {
          this.heldSchemeLook.set(name, own);
        }
      }
    }
    for (const name of names) {
      const value = dark ? (name === "color-scheme" ? "dark" : builder!.style.getPropertyValue(name)) : (this.heldSchemeLook.get(name) ?? "");
      if (value) {
        this.style.setProperty(name, value);
      } else {
        this.style.removeProperty(name);
      }
    }
    this.schemeLookApplied = dark;
  }

  /** The builder's own colour scheme: `"dark"` is the studio look's dark palette; reflects `scheme`. */
  public get scheme(): "light" | "dark" {
    return this.builderEl?.scheme ?? (this.getAttribute("scheme") === "dark" ? "dark" : "light");
  }

  public set scheme(value: "light" | "dark") {
    this.setAttribute("scheme", value === "dark" ? "dark" : "light");
  }

  /** Workspaces the bar leaves off (`hidden-workspaces`), besides any a `workspaces` list leaves out. */
  public get hiddenWorkspaces(): BuilderWorkspace[] {
    return [...this.hiddenWorkspacesValue];
  }

  public set hiddenWorkspaces(value: BuilderWorkspace[]) {
    this.changeShownWorkspaces(() => {
      this.hiddenWorkspacesValue = [...value];
    });
  }

  /**
   * The only workspaces the bar offers (`workspaces`), as a list of `form`, `logic`, `data`,
   * `languages`, `journeys`, `pdf` and `print`; `undefined` without the attribute, where every
   * workspace is offered. `hidden-workspaces`, `pdf="off"`, `journeys="off"` and `features` still
   * take away from it. A list with neither the form nor a workspace over it (Logic, Data,
   * Languages, Print) is a designer alone: `workspaces="pdf"` is the PDF layouts and nothing
   * else, `workspaces="journeys"` the journeys. The builder opens on the first one listed, the
   * form's own documents leave the bar, and a loading card stands in the builder's place until
   * that side's chunk is in. Assigning sets the attribute.
   */
  public get workspaces(): BuilderWorkspace[] | undefined {
    return this.workspacesValue ? [...this.workspacesValue] : undefined;
  }

  public set workspaces(value: readonly BuilderWorkspace[] | string | null | undefined) {
    if (value === undefined || value === null) {
      this.removeAttribute("workspaces");
      return;
    }
    const text = typeof value === "string" ? value : value.join(" ");
    if (this.getAttribute("workspaces") !== text) {
      this.setAttribute("workspaces", text);
    }
  }

  private applyWorkspaces(text: string | null): void {
    const named = text === null ? undefined : text.split(/[\s,]+/).filter((id): id is BuilderWorkspace => BUILDER_WORKSPACES.includes(id as BuilderWorkspace));
    this.changeShownWorkspaces(() => {
      // A list that names no workspace (empty, or all unknown) is no list: an empty builder helps nobody.
      this.workspacesValue = named && named.length > 0 ? [...new Set(named)] : undefined;
    });
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    builder.hiddenModeIds = this.effectiveHiddenModeIds();
    this.syncModeStatus();
    // A designer alone whose mode is already in goes on the page now; one still coming follows in `afterLateMode`.
    const alone = this.designerAlone();
    if (alone && builder.mode !== alone && builder.modes.some((mode) => mode.id === alone)) {
      builder.setMode(alone);
    }
  }

  /** Changes what `workspaceShown` answers, then tells the inner builder and loads (or leaves) the sides that moved. */
  private changeShownWorkspaces(change: () => void): void {
    const pdfShown = this.workspaceShown("pdf");
    const journeysShown = this.workspaceShown("journeys");
    change();
    if (this.builderEl) {
      this.builderEl.hiddenWorkspaces = this.effectiveHiddenWorkspaces();
    }
    // A hidden Journeys or PDF workspace fetches no mode; shown again, its mode loads.
    // A mode already registered stays, as it did before the modes were chunks.
    if (!this.pdfModeValue && pdfShown !== this.workspaceShown("pdf")) {
      this.request("pdf");
    }
    if (!this.journeyModeValue && journeysShown !== this.workspaceShown("journeys")) {
      this.request("journeys");
    }
  }

  /** What the inner builder leaves off: `hidden-workspaces`, and every workspace a `workspaces` list does not name. */
  private effectiveHiddenWorkspaces(): BuilderWorkspace[] {
    const allowed = this.workspacesValue;
    return BUILDER_WORKSPACES.filter((id) => this.hiddenWorkspacesValue.includes(id) || (allowed !== undefined && !allowed.includes(id)));
  }

  /**
   * The side a `workspaces` list makes the builder's whole page: the first of `pdf` and
   * `journeys` it names, when it names neither the form nor a workspace over the form.
   */
  private designerAlone(): "pdf" | "journeys" | undefined {
    const allowed = this.workspacesValue;
    if (!allowed || allowed.some((id) => id !== "pdf" && id !== "journeys")) {
      return undefined;
    }
    return allowed[0] as "pdf" | "journeys";
  }

  /** The modes whose documents the bar leaves out: the host's own, and the form's under a designer alone. */
  private effectiveHiddenModeIds(): string[] {
    return this.designerAlone() && !this.hiddenModeIdsValue.includes("form") ? [...this.hiddenModeIdsValue, "form"] : this.hiddenModeIdsValue;
  }

  /**
   * Which of the definition's PDF layouts is on the page (`layout-id`); `undefined` takes its
   * default, else the first. Before the PDF side is up it names the layout to open on.
   */
  public get layoutId(): string | undefined {
    return this.pdfModeValue?.layoutId ?? this.initialPdfLayoutId;
  }

  public set layoutId(value: string | undefined) {
    this.initialPdfLayoutId = value;
    const mode = this.pdfModeValue;
    if (mode && value !== undefined && mode.layouts.some((layout) => layout.id === value)) {
      mode.selectLayout(value);
    }
  }

  // --- features ---------------------------------------------------

  /**
   * Which optional parts of the builder exist, as one list: the `features` attribute, normalised
   * (the parts in a fixed order separated by spaces, `all` or `minimal` when it is either), or
   * `undefined` without one. Without a list every part exists, exactly as before the attribute was
   * added. With one, only the parts it names do — `logic`, `data`, `languages`, `translations`,
   * `journeys`, `pdf`, `variables`, `header-footer`, `data-model`, `palette`, `try-it`, `json`,
   * `binding-picker`, `advanced-fields` — besides the Form workspace with its canvas, inspector and
   * component palette; `all` names every part and `minimal` none (`minimal logic` is the form plus
   * Logic). The list is the master: `pdf="off"`, `journeys="off"`, `hidden-workspaces`,
   * `hidden-panels`, `component-types` and `file-actions` can only take more away, and a
   * `pdf` or `journeys` that asks for a side the list leaves out is ignored with one console
   * warning, as is a `workspace` for one. A part left out fetches none of its chunks. Assigning a
   * string or an array of tokens sets the attribute; a change after the builder is up rebuilds what
   * it touches (the sides, the workspaces, the strip, the bar, the inspector). `agent` (the agent
   * tools) is opt-in: not part of `all` and never on without a list; `features="all agent"`
   * turns it on, and a change that only adds or drops it reseeds nothing.
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

  /** Whether an optional part of the builder exists: always without a `features` list, else only when the list names it. */
  public featureEnabled(feature: BuilderFeature): boolean {
    return builderFeatureOn(this.featuresValue, feature);
  }

  /**
   * Strip panels the builder leaves off (`hidden-panels`): ids of its own panels — `form`,
   * `chrome`, `components`, `outline`, `variables`, `view`, `settings`, `translations`. A hidden
   * panel is never loaded, and never the one open, remembered or not. Works without `features`;
   * with it, it can only take more away.
   */
  public get hiddenPanels(): string[] {
    return this.builderEl?.hiddenPanels ?? [...this.hiddenPanelsValue];
  }

  public set hiddenPanels(value: string[]) {
    this.hiddenPanelsValue = [...(value ?? [])];
    if (this.builderEl) {
      this.builderEl.hiddenPanels = this.hiddenPanelsValue;
    }
  }

  /**
   * Settings the host manages (`managed-settings`): property paths, or `answersFree` for
   * `data.answersFree`. The inspector shows "Managed by the site." in place of each box and
   * the stored value is left alone. A site that strips an author's `answersFree` sets
   * `["answersFree"]`. None by default: every setting is shown.
   */
  public get managedSettings(): string[] {
    return this.builderEl?.managedSettings ?? [...this.managedSettingsValue];
  }

  public set managedSettings(value: string[]) {
    this.managedSettingsValue = [...(value ?? [])];
    if (this.builderEl) {
      this.builderEl.managedSettings = this.managedSettingsValue;
    }
  }

  private applyFeatures(next: BuilderFeatureSet, _text: string | null): void {
    const previous = this.featuresValue;
    this.featuresValue = next;
    // A list that differs only in `agent`: nothing the inner builder or the
    // sides read moved, so nothing is reseeded; the agent tools are registered or withdrawn alone.
    // The inner builder still takes the list: its `features` setter only re-syncs its
    // parts, never the tree, so its history, selection and drafts stay, and its own
    // `featureEnabled("agent")` reads what this element's does.
    if (differsOnlyInAgent(previous, next)) {
      const builder = this.builderEl;
      if (builder) {
        builder.features = this.innerFeatures();
      }
      this.syncAgent(true);
      return;
    }
    this.syncAgent(true);
    const builder = this.builderEl;
    if (builder) {
      builder.features = this.innerFeatures();
    } else {
      // The workspace asked for may come before the list in the markup: it is read again under it.
      const asked = this.getAttribute("workspace") as BuilderWorkspace | null;
      if (asked) {
        this.workspaceValue = this.allowedWorkspace(asked);
      }
    }
    // The sides under the new list: a mode the list leaves out is taken down, one it names brought in.
    this.request("pdf");
    this.request("journeys");
    this.request("mode");
  }

  /** The list as the inner builder is given it. */
  private innerFeatures(): string | undefined {
    const set = this.featuresValue;
    return set === undefined ? undefined : normalizeBuilderFeatures([...set]);
  }

  /** A workspace asked for, or the form with one warning when the `features` list leaves it out. */
  private allowedWorkspace(id: BuilderWorkspace | undefined): BuilderWorkspace | undefined {
    if (id === undefined || !(["logic", "data", "languages", "journeys", "pdf", "print"] as const).includes(id as "logic") || this.featureEnabled(id as BuilderFeature)) {
      return id;
    }
    warnBuilderFeatureOnce(`workspace:${id}`, `workspace attribute ignored: "${id}" is not in features`);
    return "form";
  }

  /** Whether the PDF side is off: by its attribute, or because the `features` list leaves it out. */
  private pdfOff(): boolean {
    return this.pdfValue === "off" || !this.featureEnabled("pdf");
  }

  /** Whether the Journeys side is off: by its attribute, or because the `features` list leaves it out. */
  private journeysOff(): boolean {
    return this.journeys === "off" || !this.featureEnabled("journeys");
  }

  /** Warns once for a `pdf` or `journeys` that asks for a side the `features` list leaves out (the sides stay off either way). */
  private reportIgnoredSides(): void {
    builderSides({ features: this.featuresValue, pdf: this.pdfValue, journeys: this.journeys, hiddenWorkspaces: this.effectiveHiddenWorkspaces() });
  }

  /** The modes the builder offers: the form, the PDF side and the journeys, each when it is on. */
  public get modes(): Array<{ id: string; label: string }> {
    return this.builderEl?.modes ?? [{ id: "form", label: "Form" }];
  }

  /** Which side is on the page: `"form"`, `"pdf"` or `"journeys"`. Assigning switches, through the unsaved-edits guard. */
  public get mode(): string {
    return this.builderEl?.mode ?? this.modeValue ?? "form";
  }

  public set mode(value: string) {
    this.modeValue = value;
    if (this.getAttribute("mode") !== value) {
      this.setAttribute("mode", value);
    }
    this.request("mode");
  }

  /**
   * Switches sides now; returns whether the switch started (a held unsaved-edits prompt means not
   * yet). The PDF or Journeys side asked for while its chunk is still coming is put on
   * the page once it registers, and counts as started.
   */
  public setMode(id: string): boolean {
    this.modeValue = id;
    const builder = this.builderEl;
    if (builder && this.designerLoading(id)) {
      this.pendingDesignerMode = id;
      return true;
    }
    this.pendingDesignerMode = undefined;
    if (!builder || !builder.modes.some((mode) => mode.id === id)) {
      return false;
    }
    return builder.setMode(id);
  }

  /** Whether the bar shows the document tabs (the form, the PDF layouts). Default `true`. */
  public get showModeSwitch(): boolean {
    return this.showModeSwitchValue;
  }

  public set showModeSwitch(value: boolean) {
    this.showModeSwitchValue = value;
    if (this.builderEl) {
      this.builderEl.showModeSwitch = value;
    }
  }

  /** Modes whose tabs the bar leaves out — `["form"]` for the standalone PDF designer. The mode stays reachable by API. */
  /**
   * The key the shell remembers its panels under: the strip's open panel, the
   * column widths and the inspector's fold come back for the next shell with the same key.
   * Reflects `persist-panels`; unset, nothing is remembered.
   */
  public get persistPanels(): string | undefined {
    return this.builderEl?.persistPanels ?? this.persistPanelsValue;
  }

  public set persistPanels(value: string | undefined) {
    if (value === undefined) {
      this.removeAttribute("persist-panels");
    } else if (this.getAttribute("persist-panels") !== value) {
      this.setAttribute("persist-panels", value);
    }
  }

  public get hiddenModeIds(): string[] {
    return [...this.hiddenModeIdsValue];
  }

  public set hiddenModeIds(value: string[]) {
    this.hiddenModeIdsValue = [...value];
    if (this.builderEl) {
      this.builderEl.hiddenModeIds = this.effectiveHiddenModeIds();
    }
  }

  // --- the bar's file actions ----------------------------------------------

  /**
   * The bar's file actions as they stand: New, Open and Download, each the element's own over
   * the whole definition unless the page handed in its own, and only those `file-actions`
   * lets show (all three when it says nothing). Assigning takes the page's own for any of them, merged over the element's: a
   * function replaces that action, `null` puts its button away, and a key left out (or
   * `undefined`) keeps the element's own; assigning `undefined` goes back to the element's own
   * for all three. With New comes `isEmpty`, the element's own check that a New loses nothing
   * (the page's own, or `null` to leave it to the builder's check of the tree alone). The
   * builder does the asking — the unsaved-edits guard, the confirmation, the file picker, the
   * download — and each completed action is reported as `datum-builder-file-action`, with the
   * definition after it.
   */
  public get fileActions(): BuilderFileActions {
    const shown = this.fileActionsNamed ?? new Set<FileActionName>(FILE_ACTION_NAMES);
    const override = this.fileActionsOverride ?? {};
    const own = this.ownFileActions;
    const actions: BuilderFileActions = {};
    const newAction = shown.has("new") ? chosenAction(override.new, own.new) : undefined;
    const openAction = shown.has("open") ? chosenAction(override.open, own.open) : undefined;
    const downloadAction = shown.has("download") ? chosenAction(override.download, own.download) : undefined;
    // Only New asks whether the form is empty.
    const isEmpty = newAction ? chosenAction(override.isEmpty, own.isEmpty) : undefined;
    if (newAction) {
      actions.new = newAction;
    }
    if (openAction) {
      actions.open = openAction;
    }
    if (downloadAction) {
      actions.download = downloadAction;
    }
    if (isEmpty) {
      actions.isEmpty = isEmpty;
    }
    // Save is there only when the page asks for one, whatever `file-actions` names:
    // the element has nowhere of its own to keep a form. The page's function comes first; else
    // the element's own Save, which the `save` attribute turns on (see {@link ownSave}).
    const save = typeof override.save === "function" ? override.save : this.saveValue !== false ? this.ownSave : undefined;
    if (save) {
      actions.save = save;
      const label = typeof override.saveLabel === "string" ? override.saveLabel : this.saveLabelValue;
      if (label !== undefined) {
        actions.saveLabel = label;
      }
    }
    return actions;
  }

  public set fileActions(value: DatumFormBuilderFileActions | undefined) {
    this.fileActionsOverride = value ? { ...value } : undefined;
    this.syncFileActions();
  }

  /**
   * The element's own Save (the `save` attribute): `false` for none; `true` (the bare attribute,
   * or an empty string) for a Save and Ctrl/Cmd+S that fire `datum-builder-save` and send
   * nothing, the page storing the form in its listener; an address for the same, with the
   * element then sending the definition there as JSON by `saveMethod` and taking any 2xx answer
   * as saved. Relative addresses read against the page. The attribute's address is held to the
   * page's origin unless `allow-origins` lists another; the property may name any. A
   * `fileActions.save` function wins over it.
   */
  public get save(): string | boolean {
    return this.saveValue;
  }

  public set save(value: string | boolean | null | undefined) {
    if (typeof value === "string") {
      this.saveValue = value.trim() || true;
    } else {
      this.saveValue = value === true;
    }
    this.syncFileActions();
  }

  /** The request a `save` address is sent by: `PUT` unless `save-method` says `POST`. */
  public get saveMethod(): string {
    return this.saveMethodValue;
  }

  public set saveMethod(value: string | undefined) {
    const method = value?.trim().toUpperCase();
    if (method === undefined || method === "") {
      this.saveMethodValue = SAVE_METHODS[0];
      return;
    }
    if (!(SAVE_METHODS as readonly string[]).includes(method)) {
      reportError(this, "save-method.invalid", `save-method must be ${SAVE_METHODS.join(" or ")}, not ${JSON.stringify(value)}`);
      return;
    }
    this.saveMethodValue = method as SaveMethod;
  }

  /** Save's name in the menu (the `save-label` attribute): "Save" unless given; a `fileActions.saveLabel` wins. */
  public get saveLabel(): string | undefined {
    return this.saveLabelValue;
  }

  public set saveLabel(value: string | undefined) {
    this.saveLabelValue = value?.trim() || undefined;
    this.syncFileActions();
  }

  /**
   * The element's own Save, behind the `save` attribute: `datum-builder-save` first, with the
   * form as it is sent, for the page to store it or to add to the storing (`waitUntil`); then,
   * with an address in `save` and unless a listener cancelled the event, the
   * element's own request. Once all of it has succeeded the form as sent is the saved one, so
   * `dirty` clears, and stays set for an edit made while the save ran. Anything that fails is
   * the save failing: the builder shows the reason beside the menu and the form stays unsaved.
   */
  private readonly ownSave = async (context: SaveContext): Promise<void> => {
    const definition = this.definition;
    const waits: Promise<unknown>[] = [];
    let dispatching = true;
    const detail: DatumFormBuilderSaveDetail = {
      definition,
      localeChanges: context.localeChanges,
      ...(context.trigger === undefined ? {} : { trigger: context.trigger }),
      waitUntil: (work) => {
        if (!dispatching) {
          throw new Error("waitUntil() must be called while datum-builder-save is being dispatched");
        }
        waits.push(Promise.resolve(work));
      }
    };
    let proceed: boolean;
    try {
      proceed = emit<DatumFormBuilderSaveDetail>(this, "datum-builder-save", detail, { cancelable: true });
    } finally {
      dispatching = false;
    }
    await Promise.all(waits);
    const url = this.saveValue;
    if (proceed && typeof url === "string") {
      await this.sendSave(url, definition);
    }
    this.savedDefinition = definition;
  };

  /** The request of `save="/url"`: the definition as JSON; a failure worded for "Could not save: …". */
  private async sendSave(url: string, definition: FormDefinition): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: this.saveMethodValue,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(definition),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error((error as { name?: string } | null)?.name === "TimeoutError" ? "the server took too long to answer" : "the server could not be reached");
    }
    if (!response.ok) {
      throw new Error(`the server answered ${response.status} ${response.statusText}`.trim());
    }
  }

  /**
   * The server's checks Try it can run on the answers tried: a WebAssembly sandbox's
   * run, say, so an author sees the verdict a submission would get. Unset, Try it checks in the
   * browser alone.
   */
  public get serverChecks(): TryItServerChecks | undefined {
    return this.serverChecksValue;
  }

  public set serverChecks(value: TryItServerChecks | undefined) {
    this.serverChecksValue = value;
    if (this.builderEl) {
      this.builderEl.serverChecks = this.tryItChecks();
    }
  }

  /**
   * Try it's WebAssembly validator: absent or `"auto"`, the sandbox module
   * `datum-wasm.js` beside this bundle; a URL, that module; `"off"`, none. Nothing is fetched
   * until the author turns the validator on in Try it, and a module that is not there is said
   * to be unavailable there. A page's own `serverChecks` wins over it.
   */
  public get wasm(): string | undefined {
    return this.wasmValue;
  }

  public set wasm(value: string | undefined) {
    this.wasmValue = value;
    if (this.builderEl) {
      this.builderEl.serverChecks = this.tryItChecks();
    }
  }

  /** What Try it validates with on the server's side: the page's checks, else the sandbox `wasm` names. */
  private tryItChecks(): TryItServerChecksSource | undefined {
    return this.serverChecksValue ?? this.wasmChecks();
  }

  /**
   * A loader of the sandbox `wasm` names, wired with the plugins' sandbox modules:
   * the same kernel and validators a submission meets, run on the answers tried, under the
   * strict policy (no network, files, processes or environment).
   */
  private wasmChecks(): TryItServerChecksSource | undefined {
    const spec = this.wasmValue?.trim() || "auto";
    if (spec === "off" || spec === "none") {
      return undefined;
    }
    const plugins = this.allPlugins().flatMap((plugin) => (plugin.wasmPlugin ? [plugin.wasmPlugin as WasmPluginModule] : []));
    const memo = this.wasmChecksMemo;
    if (memo && memo.spec === spec && memo.plugins.length === plugins.length && memo.plugins.every((module, index) => module === plugins[index])) {
      return memo.source;
    }
    const policy: WasmSandboxPolicy = { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false };
    const source: TryItServerChecksSource = () =>
      loadWasmValidationHost(spec, plugins).then(
        (host): TryItServerChecks => ({
          label: "WebAssembly",
          run: async ({ root, answers, locale, kinds, hostContext }) => {
            const outcome = await host.run({
              context: {
                formId: this.definition.id,
                values: answers,
                locale,
                form: root,
                ...(this.definition.translations !== undefined ? { translations: this.definition.translations } : {}),
                // The form's `kinds` map as Save writes it: the kernel checks a `gcds-date` as a date, as the browser does.
                ...(kinds !== undefined ? { kinds } : {}),
                // The host values Try it's Settings gave, so a `host.` rule is judged here as the preview judges it.
                ...(hostContext !== undefined ? { hostContext } : {}),
                unknownFields: "strip"
              },
              policy
            });
            return { errors: outcome.errors };
          }
        }),
        (error: unknown) => {
          // Said plainly in Try it: the file the page did not ship, rather than a module error.
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(spec === "auto" ? `datum-wasm.js was not found beside the builder (${reason})` : `the module at ${spec} did not load (${reason})`);
        }
      );
    this.wasmChecksMemo = { spec, plugins, source };
    return source;
  }

  /** Hands the file actions as they stand to the inner builder, which draws a button for each. */
  private syncFileActions(): void {
    if (this.builderEl) {
      this.builderEl.fileActions = this.fileActions;
    }
  }

  /**
   * Puts a definition in place for a file action now rather than on the next microtask, so
   * the `"init"` change it causes, and the `datum-builder-file-action` that follows, already
   * carry it (tree, languages, PDF layouts and journeys: see {@link flush}). All or nothing: a
   * definition the builder cannot take leaves the form as the author had it — reseeded from
   * the definition as it stood, the edits since the last seed included — and the error goes
   * on to the builder, which shows it on the bar.
   */
  private replaceDefinition(definition: FormDefinition): void {
    this.refuseWhileSrcLoads();
    const previous = this.definition;
    this.takeDefinition(definition);
    try {
      this.flush();
      // The author's own form now, as one the page assigned: a later `src` does not replace it.
      this.definitionAssigned = true;
    } catch (error) {
      this.seed = previous;
      this.seedBeforeReplace = undefined;
      // The builder's stored options may hold the refused tree by now: the form's go back.
      this.pending.add("options");
      try {
        this.flush();
      } catch {
        // The form as it stood seeded the builder before; nothing better to go back to.
      }
      throw error;
    }
  }

  // --- reads and actions ------------------------------------------------

  /** The inner `<datum-builder>`, for a page that wants the engine's full surface. */
  public get builder(): DatumBuilderElement | undefined {
    return this.builderEl;
  }

  /**
   * @internal What the agent tools' host reads for `builder-not-ready`:
   * `"loading"` while the shell is not built or the builder's init is held through a
   * reseed, else `"ready"`; never `"failed"`. Read by the agent chunk alone (`builder/agent-host.ts`
   * and `builder/agent.ts`); not part of the attribute reference.
   */
  public get agentBuildState(): "loading" | "ready" {
    return this.builderEl === undefined || this.heldInit !== undefined ? "loading" : "ready";
  }

  /**
   * @internal Each designer side as the agent tools read it: `"off"` while the side is off (its attribute or the `features` list),
   * `"hidden"` while the host hides its workspace, else its mode's load state. A side that is on
   * and shown but whose load has not started yet (`"none"`: the moment before the next mode sync
   * fetches it) reads `"loading"`, so a call then is told to come back rather than that the side
   * is missing. Read by the agent chunk alone (`builder/agent-host.ts`); not in the attribute
   * reference.
   */
  public get agentModeState(): Record<"journeys" | "pdf", DesignerState> {
    const state = (side: "journeys" | "pdf"): DesignerState => {
      if (side === "pdf" ? this.pdfOff() : this.journeysOff()) {
        return "off";
      }
      if (!this.workspaceShown(side)) {
        return "hidden";
      }
      const load = this.modeLoadState(side);
      return load === "none" ? "loading" : load;
    };
    return { journeys: state("journeys"), pdf: state("pdf") };
  }

  /**
   * @internal The answers typed in Try it over the host's sample values, as a runtime for a PDF
   * preview, or `undefined` while Try it holds none: what the PDF mode's
   * `triedRuntime` option answers, shared with the agent tools' `documents { preview_pdf }`
   * so both print the same answers.
   */
  public agentTriedRuntime(): ReturnType<typeof createFormRuntime> | undefined {
    const tried = this.triedAnswers();
    return Object.keys(tried).length > 0 ? this.sampleRuntime(tried) : undefined;
  }

  /**
   * @internal The host's sample values with no tried answers, as a runtime for a PDF preview: what
   * the PDF mode's `runtime` option answers.
   */
  public agentSampleRuntime(): ReturnType<typeof createFormRuntime> {
    return this.sampleRuntime();
  }

  /**
   * @internal The locale the PDF designer resolves its text in (the host's `locale`, else the
   * seed's default locale): what the PDF mode's `locale` option answers, shared with the agent
   * tools' template list so it names each site template in the words of the person's own Add menu.
   */
  public agentPdfLocale(): string | undefined {
    return this.localeValue ?? declaredDefaultLocale(this.seed.localization);
  }

  // --- the agent tools ----------------------------------------

  /**
   * The tools a browser agent (WebMCP) and page script can call on this page: the page
   * registrar's routing wrappers, the builder's own catalogue (its twenty-four tools) and the page's
   * session pair, with a form's tools beside them when a `<datum-form>` on the page has its own.
   * Rejects when the `features` list leaves `agent` out (it is opt-in: `features="all agent"`), and
   * with the loader's `ChunkLoadError`, after `datum-error`, when the agent chunk could not be
   * loaded; the next call asks for the chunk again.
   */
  public async agentTools(): Promise<readonly AgentTool[]> {
    const attachment = await this.requireAgent("agentTools()");
    return attachment.tools();
  }

  /**
   * Runs one agent tool by name with the same pipeline the browser uses and resolves
   * to its envelope, a refusal included; rejects only as `agentTools()` does.
   */
  public async executeAgentTool(name: string, input: unknown = {}): Promise<AgentToolResult> {
    const attachment = await this.requireAgent("executeAgentTool()");
    return attachment.execute(name, input);
  }

  /** The chunk's attachment for a call: the token must be on and the element on the page. */
  private requireAgent(what: string): Promise<BuilderAgentAttachment> {
    if (this.featuresValue?.has("agent") !== true) {
      return Promise.reject(new Error(`${what} is not available: the features list of this <${this.tagName.toLowerCase()}> does not include "agent"`));
    }
    if (!this.isConnected) {
      return Promise.reject(new Error(`${what} needs this <${this.tagName.toLowerCase()}> to be on the page`));
    }
    this.syncAgent();
    return this.agentAttachment!.then((attachment) => {
      if (attachment === undefined) {
        throw new Error(`${what}: the <${this.tagName.toLowerCase()}> left the page while the agent tools were loading`);
      }
      return attachment;
    });
  }

  /**
   * Registers or withdraws the agent tools as the `agent` token and the connection come and go, the way `<datum-form>` does: a per-connection AbortController and one chunk load
   * when on; the registration withdrawn with its reason and the signal aborted when off. A chunk
   * that does not arrive is reported once as `datum-error` and forgotten, so the next call or
   * toggle asks again. A builder without the token creates no controller and loads nothing.
   */
  private syncAgent(reannounce = false): void {
    const wanted = this.isConnected && this.featuresValue?.has("agent") === true;
    if (wanted) {
      if (this.agentAbort !== undefined) {
        // A `features` change that kept the token says the page's tools again.
        if (reannounce) {
          this.agentLive?.announce();
        }
        return;
      }
      const controller = new AbortController();
      this.agentAbort = controller;
      // One handler after the attach, as on <datum-form>: a chunk that does not arrive and an
      // attach that throws both end in one datum-error and a forgotten attachment.
      const attachment = loadAgent()
        .then((module) => {
          if (controller.signal.aborted) {
            return undefined;
          }
          const live = module.attachBuilderAgent(this, controller.signal);
          this.agentLive = live;
          return live;
        })
        .catch((error: unknown) => {
          if (this.agentAbort === controller) {
            this.agentAbort = undefined;
            this.agentAttachment = undefined;
          }
          // Whatever an attach that threw half-way registered goes with its signal.
          controller.abort();
          reportError(this, error instanceof Error && error.name === "ChunkLoadError" ? "file.unavailable" : "agent.attach-failed", error instanceof Error ? error.message : String(error), error);
          throw error;
        });
      attachment.catch(() => {});
      this.agentAttachment = attachment;
      return;
    }
    const controller = this.agentAbort;
    if (controller === undefined) {
      return;
    }
    this.agentAbort = undefined;
    this.agentAttachment = undefined;
    const live = this.agentLive;
    this.agentLive = undefined;
    live?.detach(this.isConnected ? "features-changed" : "disconnected");
    controller.abort();
  }

  /** The engine's `BuilderController` behind the form's panels. */
  public get controller(): BuilderController | undefined {
    return this.builderEl?.controller;
  }

  /** Undoes on the side the author is looking at. */
  public undo(): void {
    this.builderEl?.undo();
  }

  public redo(): void {
    this.builderEl?.redo();
  }

  /**
   * Whether edits are held outside the tree on the side that is on the page: an inspector draft
   * not yet applied, or an editor's own (a Logic rule not applied, a PDF template mapping not
   * saved) that `requestLeave` would ask about.
   */
  public hasUnsavedChanges(): boolean {
    const controller = this.builderEl?.activeController;
    return controller ? controller.hasPendingChanges() || controller.hasPendingLeaveGuard() : false;
  }

  /**
   * The net change to the form's languages since it was loaded or last saved — what a host
   * keeping a translation catalog applies to it when it saves.
   * The File menu's Save hands the same to `fileActions.save` as `localeChanges`.
   */
  public localeChangesSinceSave(): LocaleChanges {
    return this.builderEl?.localeChangesSinceSave() ?? { removed: [], renamed: [] };
  }

  /** The languages as they stand are the baseline: call it after a save of your own, once `localeChangesSinceSave()` is applied (`markSaved()` does). */
  public markLocalesSaved(): void {
    this.builderEl?.markLocalesSaved();
  }

  /** Opens the builder's command palette; Ctrl+K / Cmd+K does the same inside it. */
  public openPalette(): Promise<void> {
    return this.builderEl?.openPalette() ?? Promise.resolve();
  }

  /**
   * Adds the page's own commands to the palette, read each time it opens: Save,
   * Publish, Sign. Returns the way to take them out. Made before the builder is up, they wait.
   */
  public registerCommands(source: BuilderCommandSource): () => void {
    this.commandSourcesValue.add(source);
    const off = this.builderEl?.registerCommands(source);
    return () => {
      this.commandSourcesValue.delete(source);
      off?.();
    };
  }

  /**
   * Runs `run` once any unsaved inspector edits are dealt with: immediately when there are
   * none, otherwise after the Save / Discard prompt the properties panel puts up is answered
   * with either. The page calls this before navigating away from the builder.
   */
  public requestLeave(run: () => void): void {
    const controller = this.builderEl?.activeController;
    if (!controller) {
      run();
      return;
    }
    controller.requestLeave(run);
  }

  // --- internals ---------------------------------------------------------

  private buildDom(): void {
    this.root.innerHTML = `
      <style>
        :host { display: block; }
        datum-builder { display: block; }
        /*
         * A contained builder fills this element's box. The box is the page's to size — a
         * height, or a flex/grid cell — and 720px is what it gets when the page says nothing.
         * The inner builder takes the full height by percentage as well as by flex, so it is
         * still bounded when the page's own stylesheet makes this element a plain block.
         */
        :host([layout="contained"]) { display: flex; flex-direction: column; height: 720px; min-height: 460px; }
        :host([layout="contained"]) datum-builder { flex: 1 1 auto; min-height: 0; height: 100%; }
        datum-builder[hidden], [data-mode-status][hidden] { display: none; }
        /* A side whose chunk is loading or failed: a card in the builder's place or above it. */
        [data-mode-status] { display: grid; gap: 8px; padding: 8px 12px; font: inherit; color: var(--db-ink, inherit); background: var(--db-surface, transparent); }
        [data-mode-status] p { margin: 0; }
        [data-mode-status] > div { display: grid; gap: 4px; justify-items: start; padding: 8px 12px; border: 1px solid currentColor; border-radius: 4px; }
        /* A Download that left something out (no Submit button) says so above the builder until dismissed. */
        [data-file-warning] { display: flex; align-items: center; gap: 12px; margin: 0 0 8px; padding: 8px 12px; font: inherit; border: 1px solid var(--db-warn-line, currentColor); border-radius: 4px; color: var(--db-ink, inherit); background: var(--db-warn-soft, transparent); }
        [data-file-warning][hidden] { display: none; }
        [data-file-warning] p { flex: 1 1 auto; margin: 0; }
      </style>
      <div data-mode-status hidden></div>
      <div data-file-warning role="status" hidden><p data-file-warning-message></p><button type="button" data-file-warning-dismiss>Dismiss</button></div>
      <datum-builder${this.innerBuilderAttributes()}>
        <slot name="toolbar-start" slot="toolbar-start"></slot>
        <slot name="toolbar" slot="toolbar"></slot>
        <slot name="canvas-actions" slot="canvas-actions"></slot>
        <slot name="history" slot="history"></slot>
        <slot name="comments" slot="comments"></slot>
        <slot name="publish" slot="publish"></slot>
        <slot name="account" slot="account"></slot>
        <slot name="strip" slot="strip"></slot>
        <slot name="panel" slot="panel"></slot>
      </datum-builder>`;
    const builder = this.root.querySelector("datum-builder") as DatumBuilderElement;
    this.builderEl = builder;
    this.modeStatusMarkup = "";
    // Retry on a failed side's card: the chunk is asked for again (the loaders forget a failed load).
    this.root.querySelector("[data-mode-status]")?.addEventListener("click", (event) => {
      const side = (event.target as Element | null)?.closest?.("[data-mode-retry]")?.getAttribute("data-mode-retry");
      if (side === "pdf" || side === "journeys") {
        // A second press while the chunk is coming does nothing (the busy button is aria-disabled).
        if (!this.retryingSides.has(side)) {
          this.retryModeLoad(side);
        }
      }
    });
    this.root.querySelector("[data-file-warning-dismiss]")?.addEventListener("click", () => {
      this.showFileWarnings([]);
      // The button went with the notice: focus goes back to the file menu, where the Download was.
      builder.shadowRoot?.querySelector<HTMLElement>("[data-file-menu]")?.focus();
    });
    builder.showModeSwitch = this.showModeSwitchValue;
    builder.hiddenModeIds = this.effectiveHiddenModeIds();
    builder.persistPanels = this.persistPanelsValue;
    builder.maxDefinitionBytes = this.maxDefinitionBytesValue;
    builder.fileActions = this.fileActions;
    builder.translationsSource = this.wiredTranslationsSource();
    for (const source of this.commandSourcesValue) {
      builder.registerCommands(source);
    }
    // Logic lists the journeys' and PDF layouts' rules read-only, from the whole definition.
    builder.logicDefinition = () => this.definition;
    builder.formulaFunctions = this.wiredFormulaFunctions();
    builder.formulaReferenceHref = this.formulaReferenceHrefValue;
    builder.printTheme = this.printThemeValue;
    // A file picked into the inspector (an ICC profile) is embedded as base64: it is weighed
    // against the cap a load holds a definition to before it lands (see definitionBytes). It is
    // weighed the way Download writes it (indented, one closing newline): the heaviest form the
    // file takes, so one that fits here opens again whichever way it was saved.
    builder.embedBudget = (extra) => ({ size: utf8Length(`${JSON.stringify(this.composeDefinition(), null, 2)}\n`) + extra, limit: this.maxDefinitionBytesValue });
    builder.textLocale = this.textLocaleValue;
    builder.textCatalog = this.textCatalogValue;
    builder.serverChecks = this.tryItChecks();
    // The seed's own `kinds` map, which Save keeps (definitionKinds(this.seed.kinds)): Try it checks with it too.
    builder.controller.openedKinds = () => this.seed.kinds;

    builder.addEventListener("builder-change", (event) => {
      const detail = (event as CustomEvent<DatumBuilderChangeDetail>).detail;
      // A preview-only change (the canvas restyled under another theme) carries the same
      // tree; a page that persisted on it would be saving nothing new.
      if (detail.reason === "preview") {
        return;
      }
      // Mid-reseed the PDF and Journeys sides still hold the old form: sent once they don't (flush).
      if (this.reseeding) {
        this.heldInit = detail;
        return;
      }
      // An edit that leaves the committed form as the last announcement had it — a draft typed
      // into the inspector, an Apply the form refused — is not the page's to hear:
      // a keystroke is no change until Apply. The dirty flag still follows it, as it did.
      if (detail.reason === "edit" && !detail.renamed && !detail.renameStepped && !detail.dataMoved && this.lastAnnouncedForm !== undefined && this.committedFormSignature() === this.lastAnnouncedForm) {
        this.afterChange(detail.reason);
        return;
      }
      if (detail.reason === "init") {
        this.seededDataPaths.clear();
        this.seededSteps.pdf.clear();
        this.seededSteps.journeys.clear();
      }
      this.emitFormChange(detail);
      this.followMovesInSeed(detail);
    });
    // The builder's file actions, as this element's own event, with the definition after each.
    builder.addEventListener("builder-file-action", (event) => {
      const detail = (event as CustomEvent<BuilderFileActionDetail>).detail;
      // A Download is the save of a builder with no Save: the form is clean after
      // it. With a Save in place — the page's function, or the element's own — that owns
      // "saved", and the languages' baseline a translation catalog reads, so a Download there
      // is an export and leaves it.
      if (detail.action === "download" && typeof this.fileActions.save !== "function") {
        this.markSaved();
      }
      const definition = this.definition;
      // Said once per Download: the notice below the bar and `warnings` on the event.
      // Any other file action puts an earlier notice away.
      const warnings: DatumFormBuilderFileWarning[] =
        detail.action === "download" && !hasSubmitButton(definition.root) ? [{ code: "no-submit-button", message: this.noSubmitWarning() }] : [];
      this.showFileWarnings(warnings);
      emit<DatumFormBuilderFileActionDetail>(this, "datum-builder-file-action", { ...detail, definition, ...(warnings.length > 0 ? { warnings } : {}) });
    });
    builder.addEventListener("builder-binding-change", (event) => {
      emit<DatumFormBuilderBindingChangeDetail>(this, "datum-builder-binding-change", (event as CustomEvent<DatumFormBuilderBindingChangeDetail>).detail);
    });
    builder.addEventListener("builder-mode-change", (event) => {
      const detail = (event as CustomEvent<BuilderModeChangeDetail>).detail;
      this.modeValue = detail.mode;
      // The author moved on while a side's chunk was coming: that move wins.
      if (!this.registeringLateMode) {
        this.pendingDesignerMode = undefined;
      }
      if (this.getAttribute("mode") !== detail.mode) {
        this.setAttribute("mode", detail.mode);
      }
      emit<DatumFormBuilderModeChangeDetail>(this, "datum-builder-mode-change", detail);
    });
    builder.addEventListener("builder-workspace-change", (event) => {
      const detail = (event as CustomEvent<BuilderWorkspaceChangeDetail>).detail;
      this.workspaceValue = detail.workspace;
      // The author moved on while a designer's chunk was coming: that move wins.
      if (!this.registeringLateMode) {
        this.pendingDesignerWorkspace = undefined;
        this.pendingDesignerMode = undefined;
      }
      if (this.getAttribute("workspace") !== detail.workspace) {
        this.setAttribute("workspace", detail.workspace);
      }
      emit<DatumFormBuilderWorkspaceChangeDetail>(this, "datum-builder-workspace-change", detail);
    });
    builder.addEventListener("builder-full-window-change", (event) => {
      const detail = (event as CustomEvent<{ fullWindow: boolean }>).detail;
      this.toggleAttribute("full-window", detail.fullWindow);
      emit<{ fullWindow: boolean }>(this, "datum-builder-full-window-change", detail);
    });
    builder.addEventListener("builder-scheme-change", (event) => {
      const detail = (event as CustomEvent<{ scheme: "light" | "dark" }>).detail;
      if (!this.forwardingSchemeRemoval && this.getAttribute("scheme") !== detail.scheme) {
        this.reflectScheme(detail.scheme);
      }
      this.syncSchemeLook();
      emit<{ scheme: "light" | "dark" }>(this, "datum-builder-scheme-change", detail);
    });
    // A dark scheme the inner builder remembered as it connected shows on this element too, with
    // no event: nothing changed, the page reads the attribute.
    if (!this.hasAttribute("scheme") && builder.scheme === "dark") {
      this.reflectScheme("dark");
    }
    this.syncSchemeLook();
    builder.addEventListener("builder-mode-error", (event) => {
      const detail = (event as CustomEvent<{ mode: string; error: unknown }>).detail;
      reportError(this, "mode.unavailable", `The "${detail.mode}" mode could not be opened`, detail.error);
    });
  }

  /**
   * What the inner builder must see as it connects: the remembered panels' key, so it
   * restores the remembered workspace first, then the workspace asked for and the ones left off.
   */
  private innerBuilderAttributes(): string {
    const attr = (name: string, value: string | undefined): string =>
      value === undefined ? "" : ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
    return (
      attr("persist-panels", this.persistPanelsValue) +
      attr("workspace", this.workspaceValue) +
      attr("hidden-workspaces", this.effectiveHiddenWorkspaces().join(" ") || undefined) +
      // The parts the list leaves out are not built at all, so these go in with the markup.
      attr("hidden-panels", this.hiddenPanelsValue.length > 0 ? this.hiddenPanelsValue.join(" ") : undefined) +
      attr("managed-settings", this.managedSettingsValue.length > 0 ? this.managedSettingsValue.join(" ") : undefined) +
      attr("features", this.innerFeatures()) +
      (this.hasAttribute("full-window") ? " full-window" : "") +
      (this.hasAttribute("no-full-window") ? " no-full-window" : "") +
      attr("scheme", this.getAttribute("scheme") ?? undefined) +
      (this.hasAttribute("no-scheme-toggle") ? " no-scheme-toggle" : "")
    );
  }

  /** The form side as committed — tree, identity, languages, tests — as JSON; drafts are not in it. */
  private committedFormSignature(): string {
    const builder = this.builderEl;
    return JSON.stringify([builder?.value, builder?.identity, builder?.localization, builder?.tests]);
  }

  /** The builder's form-side change as this element's `datum-builder-change`, with the whole definition. */
  private emitFormChange(detail: DatumBuilderChangeDetail): void {
    this.lastAnnouncedForm = this.committedFormSignature();
    emit<DatumFormBuilderChangeDetail>(this, "datum-builder-change", {
      definition: this.definition,
      reason: detail.reason,
      mode: "form",
      selectedComponentId: detail.selectedComponentId,
      // Copies: the seed route reads this change's detail again after the page has heard.
      ...(detail.renamed ? { renamed: copyOfRename(detail.renamed) } : {}),
      ...(detail.renameStepped ? { renameStepped: { ...detail.renameStepped } } : {}),
      ...(detail.dataMoved ? { dataMoved: detail.dataMoved.map((move) => ({ from: move.from, to: move.to })) } : {}),
      ...(detail.historyStep ? { historyStep: detail.historyStep } : {})
    });
  }

  private request(update: Update): void {
    this.pending.add(update);
    if (this.flushQueued) {
      return;
    }
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.safeFlush();
    });
  }

  /**
   * {@link flush}, with a throw told to the page rather than thrown into it — on first connect
   * as on the queued route. A form the builder could not be seeded with, past the checks of the
   * routes, is put back as it was and the builder seeded with that; anything else is a setting
   * the builder could not take, and the updates after it still go in. Each pass moves past the
   * step that threw, so this ends.
   */
  private safeFlush(): void {
    for (let attempt = 0; attempt < FLUSH_ORDER.length; attempt += 1) {
      try {
        this.flush();
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const onForm = typeof error === "object" && error !== null && formFailures.has(error);
        reportError(this, onForm ? "definition.invalid" : "builder.settings-failed", onForm ? `The builder could not take the form: ${reason}` : `The builder could not apply its settings: ${reason}`, error);
        if (this.pending.size === 0) {
          return;
        }
      }
    }
  }

  private flush(): void {
    const builder = this.builderEl;
    if (!this.isConnected || !builder || this.pending.size === 0) {
      return;
    }
    const pending = new Set(this.pending);
    this.pending.clear();
    let at: Update | undefined;
    try {
      this.applyUpdates(builder, pending, (update) => {
        at = update;
      });
    } catch (error) {
      // The updates after the one that threw are still wanted: the next pass takes them up.
      const reached = at === undefined ? -1 : FLUSH_ORDER.indexOf(at);
      for (const update of pending) {
        if (FLUSH_ORDER.indexOf(update) > reached) {
          this.pending.add(update);
        }
      }
      throw error;
    }
  }

  /** The updates in `pending`, in {@link FLUSH_ORDER}; `reached` hears which one is being applied. */
  private applyUpdates(builder: DatumBuilderElement, pending: ReadonlySet<Update>, reached: (update: Update) => void): void {
    if (pending.has("layout")) {
      reached("layout");
      builder.layout = this.layoutValue;
    }
    if (pending.has("theme")) {
      reached("theme");
      const key = `builder:${String(this.themeValue ?? "")}`;
      try {
        builder.theme = this.themesValue.resolveBuilder(this.themeValue);
        this.unresolvedThemes.delete(key);
      } catch (error) {
        builder.theme = undefined;
        reportUnresolved(this, this.unresolvedThemes, key, error, "theme.unresolved");
      }
      // The datum-dark builder theme is the dark scheme: show it on the attribute as the remembered
      // dark is shown, unless the page chose (a reflected attribute follows the inner's scheme).
      if (!this.hasAttribute("scheme") ? builder.scheme === "dark" : this.schemeAttributeReflected && this.getAttribute("scheme") !== builder.scheme) {
        this.reflectScheme(builder.scheme);
      }
      // The dark look's tokens follow the theme.
      this.syncSchemeLook();
    }
    if (pending.has("options")) {
      reached("options");
      // The whole option set, initial root included: this is the one path that reseeds the
      // tree, so it runs only for the inputs that genuinely change what is being edited. The
      // PDF side starts over on the new form's layouts with it. The builder's "init" change is
      // held until every side is on the new form, so it carries the new layouts and journeys.
      this.reseeding = true;
      this.heldInit = undefined;
      try {
        builder.options = this.buildOptions();
        // The form's scenarios ride beside the options, not in them: a silent feed that
        // the options' reseed leaves alone, so they are set after it, as the seed carried them.
        builder.tests = this.seed.tests;
        builder.formulaFunctions = this.wiredFormulaFunctions();
        this.pdfModeValue?.reseed({ pdf: this.seed.pdf, root: builder.value });
        this.journeyModeValue?.reseed(this.seed.journey);
        this.seedBeforeReplace = undefined;
        const warning = this.heldLoadWarning;
        this.heldLoadWarning = undefined;
        if (warning) {
          reportWarning(this, warning);
        }
      } catch (error) {
        // The form the builder could not take is not the form: the one before it is put back and seeded again.
        const back = this.seedBeforeReplace;
        this.seedBeforeReplace = undefined;
        this.heldLoadWarning = undefined;
        if (back && back !== this.seed) {
          this.seed = back;
          this.pending.add("options");
        }
        if (typeof error === "object" && error !== null) {
          formFailures.add(error);
        }
        throw error;
      } finally {
        this.reseeding = false;
      }
      const held = this.heldInit;
      this.heldInit = undefined;
      if (held) {
        this.emitFormChange(held);
      }
    } else {
      // Partial updates go straight to the controller: `options` on the element merges into the
      // stored options and re-applies the initial root, which would reset the tree.
      if (pending.has("preview")) {
        reached("preview");
        builder.controller.setOptions({
          ...this.canvasBindingOptions(),
          dataSources: this.previewDataSources(),
          dataSourceIds: this.dataSourceIdsValue,
          validationCodes: this.validationCodesValue
        });
      }
      if (pending.has("locale") && this.localeValue) {
        reached("locale");
        builder.controller.setOptions({ locale: this.localeValue });
      }
    }
    if (pending.has("pdf")) {
      reached("pdf");
      this.applyPdfMode();
    }
    // After the PDF side, so the bar lists the form, its layouts, then its journeys: the PDF
    // side, added again later (pdf="off" lifted), takes its place ahead of the journeys itself.
    if (pending.has("journeys")) {
      reached("journeys");
      this.applyJourneyMode();
    }
    if (pending.has("mode")) {
      reached("mode");
      const wanted = this.designerAlone() ?? this.modeValue ?? "form";
      if (builder.modes.some((mode) => mode.id === wanted)) {
        this.pendingDesignerMode = undefined;
        builder.setMode(wanted);
      } else if (this.designerLoading(wanted)) {
        // Its chunk is coming: put on the page once it registers.
        this.pendingDesignerMode = wanted;
      }
    }
    this.syncModeStatus();
  }

  /** Registers the PDF mode (with its executor, or a loader for it), or removes it for `pdf="off"`. */
  private applyPdfMode(): void {
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    this.reportIgnoredSides();
    // Try it's Preview PDF renders through the PDF side's own support, loaded on the first preview.
    // Off by `pdf="off"` or a `features` list without `pdf`: no PDF mode, no support, no chunk.
    builder.tryPdf =
      this.pdfOff()
        ? undefined
        : () => (this.pdfSupportValue ? Promise.resolve(this.pdfSupportValue) : this.executorLoader()());
    if (this.pdfOff()) {
      this.cancelPdfModeLoad();
      if (this.pdfModeValue) {
        // The layouts as edited stay in the definition, as the journeys do when they go off.
        const edited = this.pdfModeValue.pdfConfiguration;
        if (edited && !this.featureEnabled("pdf")) {
          this.seed = { ...this.seed, pdf: edited };
        }
        builder.removeMode(this.pdfModeValue.id);
        this.pdfModeValue = undefined;
      }
      return;
    }
    if (this.pdfModeValue) {
      this.pdfModeValue.support = this.themedSupport(this.pdfSupportValue ?? this.executorLoader());
      return;
    }
    // The mode is a chunk: none is fetched for a hidden PDF workspace. Once a builder
    // on the page has it, it registers at once, as it did when it was part of the bundle.
    if (!this.workspaceShown("pdf")) {
      this.cancelPdfModeLoad();
      return;
    }
    const loaded = loadedPdfBuilderMode();
    if (loaded) {
      this.cancelPdfModeLoad();
      // Also the module that came while the element was off the page: what was asked meanwhile follows.
      this.registerLateMode(builder, "pdf", () => this.registerPdfMode(builder, loaded));
      return;
    }
    const token = (this.pdfModeToken += 1);
    this.pdfModeLoading = true;
    this.pdfModeFailed = false;
    loadPdfBuilderMode().then(
      (module) => {
        if (token !== this.pdfModeToken) {
          return;
        }
        this.pdfModeLoading = false;
        if (!this.isConnected) {
          // Registered by the next connect's flush, from the module now in.
          this.pending.add("pdf");
          return;
        }
        if (this.builderEl !== builder || this.pdfModeValue || this.pdfOff() || !this.workspaceShown("pdf")) {
          this.syncModeStatus();
          return;
        }
        this.registerLateMode(builder, "pdf", () => this.registerPdfMode(builder, module));
      },
      (error: unknown) => {
        if (token !== this.pdfModeToken) {
          return;
        }
        this.modeLoadFailed("pdf", error);
      }
    );
  }

  private cancelPdfModeLoad(): void {
    this.pdfModeToken += 1;
    this.pdfModeLoading = false;
    this.pdfModeFailed = false;
  }

  private cancelJourneyModeLoad(): void {
    this.journeyModeToken += 1;
    this.journeyModeLoading = false;
    this.journeyModeFailed = false;
  }

  /**
   * A side's mode chunk failed (absent-code resilience): `datum-error`, the inline card
   * with Retry, and the side back in `pending`, so the next flush — a reconnect, any change, Retry
   * — asks for the chunk again (the loaders forget a failed load). The rest of the builder works on.
   */
  private modeLoadFailed(side: "pdf" | "journeys", error: unknown): void {
    if (side === "pdf") {
      this.pdfModeLoading = false;
      this.pdfModeFailed = true;
    } else {
      this.journeyModeLoading = false;
      this.journeyModeFailed = true;
    }
    if (this.pendingDesignerWorkspace === side) {
      this.pendingDesignerWorkspace = undefined;
    }
    // The author may have asked for the side's mode too (mode="journeys"): a later Retry must not yank them there.
    if (this.pendingDesignerMode === side) {
      this.pendingDesignerMode = undefined;
    }
    this.failedSides.add(side);
    this.syncModeStatus();
    reportError(this, "file.unavailable", side === "pdf" ? "The PDF side could not be loaded" : "The Journeys side could not be loaded", error);
  }

  /** Retry on a failed side's card: the chunk is asked for again now. */
  private retryModeLoad(side: "pdf" | "journeys"): void {
    this.failedSides.delete(side);
    this.retryingSides.add(side);
    if (side === "pdf") {
      this.pdfModeFailed = false;
    } else {
      this.journeyModeFailed = false;
    }
    this.request(side);
  }

  /**
   * Registers a side's mode, then lets what the page asked for meanwhile follow
   * ({@link afterLateMode}). A registration that throws is reported as `datum-error` and shown as
   * the side's failure card, never an unhandled rejection; the side is tried again on the next flush.
   */
  private registerLateMode(builder: DatumBuilderElement, side: "pdf" | "journeys", register: () => void): void {
    this.registeringLateMode = true;
    try {
      register();
      if (side === "pdf") {
        this.pdfModeFailed = false;
      } else {
        this.journeyModeFailed = false;
      }
      this.afterLateMode(builder, side);
    } catch (error) {
      // A mode made but never put on the bar is no mode: the seed keeps the side's block.
      if (side === "pdf" && this.pdfModeValue && !builder.modes.some((mode) => mode.id === this.pdfModeValue!.id)) {
        this.pdfModeValue = undefined;
      }
      if (side === "journeys" && this.journeyModeValue && !builder.modes.some((mode) => mode.id === this.journeyModeValue!.id)) {
        this.journeyModeValue = undefined;
      }
      this.modeLoadFailed(side, error);
      return;
    } finally {
      this.registeringLateMode = false;
    }
    this.syncModeStatus();
  }

  /** Whether a side's mode is loading, failed or registered . */
  private modeLoadState(side: "pdf" | "journeys"): "loading" | "failed" | "ready" | "none" {
    const [mode, loading, failed] =
      side === "pdf" ? [this.pdfModeValue, this.pdfModeLoading, this.pdfModeFailed] : [this.journeyModeValue, this.journeyModeLoading, this.journeyModeFailed];
    return mode ? "ready" : failed ? "failed" : loading ? "loading" : "none";
  }

  /**
   * The inline card for a side whose chunk failed — role alert, the builder's words, a Retry
   * button — and, for a designer alone (`workspaces="pdf"`), the loading card in the builder's
   * place until its mode registers. Written only when it changes.
   */
  private syncModeStatus(): void {
    const host = this.root.querySelector<HTMLElement>("[data-mode-status]");
    const builder = this.builderEl;
    if (!host || !builder) {
      return;
    }
    const cards: string[] = [];
    const word = (key: string): string => escapeText(this.shellWord(key));
    // The failure card; after Retry it stays while the chunk comes (busy: the same button, aria-disabled so it keeps focus).
    const card = (side: "pdf" | "journeys", busy: boolean): string => {
      const name = side === "pdf" ? "layouts" : "journeys";
      const retry = `<button type="button" data-mode-retry="${side}"${busy ? ' aria-disabled="true" aria-busy="true"' : ""}>${word("shell.load.retry")}</button>`;
      return busy
        ? `<div role="status" data-mode-loading="${side}"><p>${word(`shell.load.${name}`)}</p>${retry}</div>`
        : `<div role="alert" data-mode-failed="${side}"><p><strong>${word(`shell.load.failed.${name}`)}</strong></p><p>${word("shell.load.check")}</p>${retry}</div>`;
    };
    const pdf = this.modeLoadState("pdf");
    const journeys = this.modeLoadState("journeys");
    const alone = this.designerAlone();
    for (const [side, state] of [["pdf", pdf], ["journeys", journeys]] as const) {
      if (state !== "loading") {
        this.retryingSides.delete(side);
      }
    }
    if (pdf === "failed") {
      cards.push(card("pdf", false));
    } else if (pdf === "loading" && this.retryingSides.has("pdf")) {
      cards.push(card("pdf", true));
    } else if (pdf === "loading" && alone === "pdf") {
      cards.push(`<div role="status" data-mode-loading="pdf"><p>${word("shell.load.layouts")}</p></div>`);
    }
    if (journeys === "failed") {
      cards.push(card("journeys", false));
    } else if (journeys === "loading" && this.retryingSides.has("journeys")) {
      cards.push(card("journeys", true));
    } else if (journeys === "loading" && alone === "journeys") {
      cards.push(`<div role="status" data-mode-loading="journeys"><p>${word("shell.load.journeys")}</p></div>`);
    }
    const markup = cards.join("");
    if (markup !== this.modeStatusMarkup) {
      this.modeStatusMarkup = markup;
      // The Retry button the author pressed is replaced with the card: put focus on the new one.
      const hadFocus = host.contains(this.root.activeElement);
      host.innerHTML = markup;
      host.hidden = markup === "";
      if (hadFocus) {
        host.querySelector<HTMLElement>("[data-mode-retry]")?.focus();
      }
    }
    // A designer alone shows no form editor while its mode is coming or failed.
    const awaited = alone === "pdf" ? pdf : alone === "journeys" ? journeys : "none";
    const hideBuilder = awaited === "loading" || awaited === "failed";
    if (builder.hidden !== hideBuilder) {
      builder.hidden = hideBuilder;
    }
  }

  /** One of the builder's words (`shell.load.*`), asked of the inner builder so the cards say what the shell's cards say; every caller has the builder. */
  private shellWord(key: string): string {
    return this.builderEl!.shellText(key);
  }

  /** What a Download of a form with no submit button says, in the builder's language; also the event's `warnings[].message`. */
  private noSubmitWarning(): string {
    return this.builderEl!.shellText(NO_SUBMIT_WARNING_KEY);
  }

  /**
   * What one change of the form moved — a component given a new id (`renamed`), a
   * rename an Undo or a Redo made again (`renameStepped`), and where answers are stored
   * (`dataMoved`, an Undo's reversed and a Redo's repeated moves among them) — followed into the
   * PDF layouts and the journeys of the seed, for each side whose mode is not registered: off,
   * hidden, its chunk still coming or failed. The seed is no part of the form's
   * history, so every change that moved something reaches it, as one map. A registered mode
   * follows the form itself (`formRenamed`, `formDataMoved`); a mode registering later reads the
   * seed as rewritten here, and has no entry in its history for those steps, so their Undo and
   * Redo are followed into the mode here (`seededSteps`). Each side rewritten is reported as its
   * own change after the form's, as its mode would.
   */
  private followMovesInSeed(detail: DatumBuilderChangeDetail): void {
    const { renamed, renameStepped, dataMoved, historyStep } = detail;
    const rename = renamed ?? renameStepped;
    const real = rename && rename.from !== "" && rename.from !== rename.to ? rename : undefined;
    const undone = historyStep === "undo";
    const own: MovedValuePath[] = [];
    const renameKeys: string[] = [];
    if (real) {
      // The step as it was first made: an Undo's ids run the other way.
      const first = undone ? `${real.to}>${real.from}` : `${real.from}>${real.to}`;
      renameKeys.push(`rename ${first}`);
      if (renamed) {
        own.push(...(renamed.dataPath === undefined ? [] : "from" in renamed.dataPath ? [renamed.dataPath] : renamed.dataPath));
        this.seededDataPaths.set(first, [...own]);
      } else {
        // The rename's own data path was told once, with the rename; its Undo's is that, turned round.
        const told = this.seededDataPaths.get(first) ?? [];
        own.push(...(undone ? told.map((move) => ({ from: move.to, to: move.from })) : told));
      }
    }
    // What the edit moved besides the rename is told in the places the rename left them: it is followed after the rename, and an Undo's reversed moves before the rename is put back.
    const rest = dataMoved ?? [];
    const moveKeys = rest.length > 0 ? [`move ${undone ? `${rest[0]!.to}>${rest[0]!.from}` : `${rest[0]!.from}>${rest[0]!.to}`}`] : [];
    const sides = {
      pdf: this.sideToFollow("pdf", [...renameKeys, ...moveKeys], historyStep),
      journeys: this.sideToFollow("journeys", renameKeys, historyStep)
    };
    const steps = undone
      ? [() => this.followInSeed("", "", rest, sides), () => this.followInSeed(real?.from ?? "", real?.to ?? "", own, sides)]
      : [() => this.followInSeed(real?.from ?? "", real?.to ?? "", own, sides), () => this.followInSeed("", "", rest, sides)];
    for (const step of steps) {
      step();
    }
  }

  /**
   * Where one change's follow for a side goes: its seed while the side has no mode (and the step is
   * remembered, as it has no entry in a mode's history); its mode for the Undo or Redo of such a
   * step once the mode has registered; nowhere for a step a registered mode follows with an entry of its own.
   */
  private sideToFollow(side: "pdf" | "journeys", keys: readonly string[], historyStep: "undo" | "redo" | undefined): "seed" | "mode" | undefined {
    const remembered = this.seededSteps[side];
    const mode = side === "pdf" ? this.pdfModeValue : this.journeyModeValue;
    if (mode === undefined) {
      if (side === "pdf" ? this.seed.pdf : this.seed.journey) {
        for (const key of keys) {
          remembered.add(key);
        }
      }
      return "seed";
    }
    if (historyStep === undefined) {
      // A step the mode follows now holds its rewrite in the history; the same ids made again are no step of the seed's.
      for (const key of keys) {
        remembered.delete(key);
      }
      return undefined;
    }
    return keys.some((key) => remembered.has(key)) ? "mode" : undefined;
  }

  /** {@link followMovesInSeed} for the ids `from` → `to` (none when `from` is empty) and where answers went, on the sides it says. */
  private followInSeed(from: string, to: string, dataPath: readonly MovedValuePath[], sides: { pdf: "seed" | "mode" | undefined; journeys: "seed" | "mode" | undefined }): void {
    const renaming = from !== "" && from !== to;
    dataPath = dataPath.filter((move) => move.from !== "" && move.from !== move.to);
    if (!renaming && dataPath.length === 0) {
      return;
    }
    const pdfMode = sides.pdf === "mode" ? this.pdfModeValue : undefined;
    const pdf = sides.pdf === "seed" ? this.seed.pdf : pdfMode?.pdfConfiguration;
    if (sides.pdf && pdf) {
      const followed = renamePdfLayoutConditions(pdf, from, to, dataPath.length > 0 ? dataPath : undefined);
      // Formulas that spell the old id but do not parse stay as written: say so, as a registered PDF mode does.
      for (const note of renaming ? followed.unparsed : []) {
        reportError(
          this,
          "pdf.rename-unparsed",
          this.shellWord("pdf.rename.unparsed").replace(/\{(\w+)\}/g, (_match, name: string) => ({ layout: note.layoutId, where: note.where, from, to, formula: note.formula })[name] ?? "")
        );
      }
      if (followed.configuration !== pdf) {
        if (pdfMode) {
          pdfMode.pdfConfiguration = followed.configuration;
        } else {
          this.seed = { ...this.seed, pdf: followed.configuration };
        }
        const definition = this.definition;
        for (const id of followed.renamed) {
          const layout = pdfLayoutsOf(followed.configuration).find((entry) => entry.id === id);
          if (layout) {
            emit<DatumPdfLayoutChangeDetail>(this, "datum-pdf-layout-change", { layout, pdf: followed.configuration, definition, reason: "layouts" });
          }
        }
        emit<DatumFormBuilderChangeDetail>(this, "datum-builder-change", { definition, reason: "layouts", mode: "pdf", selectedComponentId: undefined });
      }
    }
    const journeyMode = sides.journeys === "mode" ? this.journeyModeValue : undefined;
    const current = sides.journeys === "seed" ? this.seed.journey : journeyMode?.journeyConfiguration;
    if (renaming && sides.journeys && current) {
      const journey = renameReferencesInConfiguration(current, from, to);
      if (journey !== current) {
        if (journeyMode) {
          journeyMode.reseed(journey);
        } else {
          this.seed = withJourney(this.seed, journey);
        }
        const definition = this.definition;
        emit<DatumJourneyChangeDetail>(this, "datum-journey-change", { configuration: journey, definition, reason: "form-rename" });
        emit<DatumFormBuilderChangeDetail>(this, "datum-builder-change", { definition, reason: "form-rename", mode: "journeys", selectedComponentId: undefined });
      }
    }
  }

  /** Whether the bar may offer this workspace: the host has not hidden it (`hidden-workspaces`) and a `workspaces` list names it. */
  private workspaceShown(id: BuilderWorkspace): boolean {
    return !this.effectiveHiddenWorkspaces().includes(id);
  }

  /** Whether `id` names the PDF or Journeys side while its mode's chunk is still coming. */
  private designerLoading(id: string): boolean {
    return (id === "pdf" && this.pdfModeLoading && !this.pdfModeValue) || (id === JOURNEY_BUILDER_MODE && this.journeyModeLoading && !this.journeyModeValue);
  }

  /**
   * A mode registered after its chunk came: what the page asked for meanwhile follows —
   * the workspace a host switched to, else the side `mode` names — as the flush that registered
   * it in one go would have done. The mode's own registration (`addMode`) is the one repaint.
   */
  private afterLateMode(builder: DatumBuilderElement, id: string): void {
    if (this.pendingDesignerWorkspace === id) {
      this.pendingDesignerWorkspace = undefined;
      this.pendingDesignerMode = undefined;
      builder.setWorkspace(id as BuilderWorkspace);
      return;
    }
    // The side asked for (`mode`, `setMode`) while it was coming, unless the author moved on
    // meanwhile; a designer alone (`workspaces="pdf"`) always opens on its own side.
    const wanted = this.pendingDesignerMode === id || this.designerAlone() === id;
    if (this.pendingDesignerMode === id) {
      this.pendingDesignerMode = undefined;
    }
    if (wanted && builder.mode !== id && builder.modes.some((mode) => mode.id === id)) {
      builder.setMode(id);
    }
  }

  /** Builds the PDF mode over the inner builder and puts it on the bar, ahead of the journeys. */
  private registerPdfMode(builder: DatumBuilderElement, module: PdfBuilderModeModule): void {
    const support = this.themedSupport(this.pdfSupportValue ?? this.executorLoader());
    const mode = module.createPdfBuilderMode({
      support,
      formRoot: () => builder.value,
      // The form's own controller: a populated form's "Create form fields" inserts there.
      form: () => builder.controller,
      pdfThemes: () => this.themesValue.pdfOptions().map(({ id, label }) => ({ id, label })),
      // The sheet's field previews show the answers from Try it over the host's values, which stay underneath.
      values: () => ({ ...this.valuesValue, ...this.triedAnswers() }),
      locale: () => this.agentPdfLocale(),
      translations: () => this.translationsValue,
      // The form's locales as the builder has committed them, so a layout's own text is
      // authored per locale — including a locale added on the Form side since the seed.
      localization: () => builder.localization,
      dataSources: () => this.previewDataSources(),
      runtime: () => this.sampleRuntime(),
      // The answers tried in Try it fill the bar's Preview PDF, laid over the host's values.
      triedRuntime: () => this.agentTriedRuntime(),
      triedCount: () => Object.keys(this.triedAnswers()).length,
      // The dialog's Clear answers.
      clearTried: () => builder.clearTriedAnswers(),
      templates: () => this.pdfTemplatesValue,
      // An uploaded template travels inside the definition as base64: the PDF side asks what the
      // form would weigh with it, against the cap a load holds a definition to, so it never
      // saves a form `src` or Open would then refuse.
      definitionBytes: (pdf) => ({ size: utf8Length(JSON.stringify(this.composeDefinition(pdf))), limit: this.maxDefinitionBytesValue }),
      pdf: this.seed.pdf,
      layoutId: this.initialPdfLayoutId,
      onChange: (detail) => {
        const definition = this.definition;
        emit<DatumPdfLayoutChangeDetail>(this, "datum-pdf-layout-change", { layout: detail.layout, pdf: detail.pdf, definition, reason: detail.reason });
        emit<DatumFormBuilderChangeDetail>(this, "datum-builder-change", { definition, reason: detail.reason, mode: "pdf", selectedComponentId: undefined });
      },
      onSelect: (detail) => emit<DatumPdfLayoutSelectDetail>(this, "datum-pdf-layout-select", detail),
      onReady: (detail) => emit<DatumPdfDesignerReadyDetail>(this, "datum-pdf-designer-ready", detail),
      onError: (message, cause) => reportError(this, "pdf.designer-failed", message, cause)
    });
    this.pdfModeValue = mode;
    // Ahead of the journeys when they are already on (a page lifting pdf="off" later), so the
    // dropdown and the + menu keep the layouts before the journeys; appended when they are not.
    builder.addMode(mode, { before: JOURNEY_BUILDER_MODE });
    this.retakeLoadBaseline();
  }

  /**
   * A mode attached after the first seeding reads its block in its own words (the PDF side's
   * default layout, say). Until the author edits anything, the definition as loaded is the saved
   * one in those words too, so `dirty` does not count the difference.
   */
  private retakeLoadBaseline(): void {
    if (this.baselineFromLoad && !this.editedSinceBaseline) {
      this.savedSignature = this.loadBaselineSignature();
      this.updateDirty();
    }
  }

  /**
   * The definition as loaded, as the saved baseline. When the PDF side left declared layouts
   * out as unusable (it says which in a `datum-error`), the baseline keeps the block as
   * declared: the definition read back no longer has them, so the builder reads as unsaved
   * from the start rather than hiding that a save would remove an author's layouts.
   */
  private loadBaselineSignature(): string {
    const declared = this.seed.pdf;
    const dropped = declared !== undefined && (this.pdfModeValue?.unusableLayouts.length ?? 0) > 0;
    return JSON.stringify(dropped ? this.composeDefinition(declared) : this.definition);
  }

  /**
   * Registers the Journeys mode over the form's controller, or, for `journeys="off"`,
   * removes it — its block folded back into the seed first, so edits made while it was on
   * stay in `definition` and come back with it. The mode is a chunk, fetched only
   * while the side is on and its workspace shown; until it registers, the definition's journeys
   * pass through from the seed as given.
   */
  private applyJourneyMode(): void {
    const builder = this.builderEl;
    if (!builder) {
      return;
    }
    this.reportIgnoredSides();
    if (this.journeysOff()) {
      this.cancelJourneyModeLoad();
      const mode = this.journeyModeValue;
      if (mode) {
        this.seed = withJourney(this.seed, mode.journeyConfiguration);
        this.journeyModeValue = undefined;
        builder.removeMode(mode.id);
      }
      return;
    }
    if (this.journeyModeValue) {
      return;
    }
    if (!this.workspaceShown("journeys")) {
      this.cancelJourneyModeLoad();
      return;
    }
    const loaded = loadedJourneyBuilderMode();
    if (loaded) {
      this.cancelJourneyModeLoad();
      // Also the module that came while the element was off the page: what was asked meanwhile follows.
      this.registerLateMode(builder, "journeys", () => this.registerJourneyMode(builder, loaded));
      return;
    }
    const token = (this.journeyModeToken += 1);
    this.journeyModeLoading = true;
    this.journeyModeFailed = false;
    loadJourneyBuilderMode().then(
      (module) => {
        if (token !== this.journeyModeToken) {
          return;
        }
        this.journeyModeLoading = false;
        if (!this.isConnected) {
          this.pending.add("journeys");
          return;
        }
        if (this.builderEl !== builder || this.journeyModeValue || this.journeysOff() || !this.workspaceShown("journeys")) {
          this.syncModeStatus();
          return;
        }
        this.registerLateMode(builder, "journeys", () => this.registerJourneyMode(builder, module));
      },
      (error: unknown) => {
        if (token !== this.journeyModeToken) {
          return;
        }
        this.modeLoadFailed("journeys", error);
      }
    );
  }

  /** Builds the Journeys mode over the form's controller, from the seed's journeys, and puts it on the bar. */
  private registerJourneyMode(builder: DatumBuilderElement, module: JourneyBuilderModeModule): void {
    const mode = module.createJourneyBuilderMode({
      form: builder.controller,
      journey: this.seed.journey,
      translations: () => this.translationsValue,
      // What a presentation's page-only fields are made from: the form's own
      // definitions, as the form's builder has them, like the PDF mode's field previews.
      formDefinitions: () => this.mergedDefinitions(),
      // The Preview view runs the journey as this element's forms run: the page's
      // data sources, translations, components and plugins, and no draft store or sandbox,
      // which a preview has no use for. The journeys are the designer's, so it is a preview:
      // nothing is checked against a server. The mode switches it to the builder's locale.
      previewRuntime: ({ journeyConfiguration, journeyId }) =>
        createFormRuntime(this.definition, {
          dataSources: this.dataSourcesValue,
          translations: this.translationsValue,
          componentDefinitions: this.componentDefinitionsValue,
          plugins: this.pluginsValue,
          pluginRegistry: this.pluginRegistryValue,
          journeyConfiguration,
          journey: journeyId,
          // A preview of a form being edited opens whatever the author has typed.
          formulaErrors: "warn"
        }),
      onChange: (detail) => {
        const definition = this.definition;
        emit<DatumJourneyChangeDetail>(this, "datum-journey-change", {
          ...(detail.journey ? { journey: detail.journey } : {}),
          configuration: detail.configuration,
          definition,
          reason: detail.reason,
          ...(detail.renamed ? { renamed: detail.renamed } : {})
        });
        emit<DatumFormBuilderChangeDetail>(this, "datum-builder-change", { definition, reason: detail.reason, mode: "journeys", selectedComponentId: undefined });
      },
      onSelect: (detail) => emit<DatumJourneySelectDetail>(this, "datum-journey-select", detail),
      onError: (message, cause) => reportError(this, "journeys.designer-failed", message, cause)
    });
    this.journeyModeValue = mode;
    builder.addMode(mode);
    this.retakeLoadBaseline();
  }

  /**
   * How the executor arrives when the page built none: the chunk of this bundle (absent or
   * `"auto"`), or the module a URL names. Fonts come from `fonts/` beside whichever it is.
   * The page imagery for template areas follows the same choice — the chunk of
   * this bundle, or `datum-pdf-pages.js` beside the module named — unless `pdf-pages` names
   * another URL or is `"off"`; it is fetched with the executor and, failing, left out, which
   * the area editor shows as blank sheets.
   */
  private executorLoader(): () => Promise<PdfBuilderModeSupport> {
    const spec = this.pdfValue?.trim();
    const pagesSpec = this.pdfPagesValue?.trim();
    const withPages = (support: PdfBuilderModeSupport, pages: () => Promise<PdfPageRasterizer>): Promise<PdfBuilderModeSupport> =>
      pagesSpec === "off"
        ? Promise.resolve(support)
        : pages().then(
            (rasterizer) => ({ ...support, pages: rasterizer }),
            (cause: unknown) => {
              // The imagery module is missing: the area editor must say so ("Page images
              // unavailable (reason), blank sheets"), not draw blank sheets as if none were
              // asked for, and the page hears it. A rasterizer that refuses
              // to open is how the editor learns the reason.
              reportError(this, "file.unavailable", "The PDF page images could not be loaded", cause);
              const reason = cause instanceof Error ? cause.message : String(cause);
              return { ...support, pages: { open: () => Promise.reject(new Error(reason)) } };
            }
          );
    if (spec && spec !== "auto") {
      const pdfModuleUrl = resolvePdfModuleUrl(spec);
      return () => loadPdfSupport(spec).then((support) => withPages(support, () => loadPdfPageRasterizer(resolvePdfPagesModuleUrl(pagesSpec, pdfModuleUrl))));
    }
    if (pagesSpec && pagesSpec !== "auto" && pagesSpec !== "off") {
      return () =>
        import("./pdf.js").then((module) => module.createPdfSupport()).then((support) => withPages(support, () => loadPdfPageRasterizer(resolvePdfPagesModuleUrl(pagesSpec, defaultPdfModuleUrl()))));
    }
    return () =>
      import("./pdf.js")
        .then((module) => module.createPdfSupport())
        .then((support) => withPages(support, () => import("./pdf-pages.js").then((module) => module.createPdfPageRasterizer())));
  }

  /**
   * The answers the author typed in Try it, as a plain object keyed by value path:
   * typed ones only, not the page's sample values. One set for the Form, Journeys and PDF sides;
   * a page building its own PDF preview lays them over its values. `{}` before the builder is up.
   */
  public triedAnswers(): Record<string, unknown> {
    const values = this.builderEl?.triedAnswers();
    const answers: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!key.startsWith("@") && value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
        answers[key] = value;
      }
    }
    return answers;
  }

  /** Empties the answers tried in Try it (the Try panel's Clear answers does the same). */
  public clearTriedAnswers(): void {
    this.builderEl?.clearTriedAnswers();
  }

  /** A runtime over the form and the sample answers (with `tried` laid over them), for the PDF side's previews and test fills. */
  private sampleRuntime(tried: Record<string, unknown> = {}): ReturnType<typeof createFormRuntime> {
    const runtime = createFormRuntime(this.definition, {
      dataSources: this.dataSourcesValue,
      translations: this.translationsValue,
      componentDefinitions: this.componentDefinitionsValue,
      plugins: this.pluginsValue,
      pluginRegistry: this.pluginRegistryValue,
      // A preview of a form being edited opens whatever the author has typed.
      formulaErrors: "warn"
    });
    for (const [path, value] of Object.entries({ ...this.valuesValue, ...tried })) {
      runtime.setValue(path, value);
    }
    if (this.localeValue) {
      try {
        runtime.setLocale(this.localeValue);
      } catch {
        // An unsupported locale prints in the form's default one.
      }
    }
    return runtime;
  }

  // `translations` rides the options as the controller reads it; the shell's option type does not
  // name it, so it is widened here and nowhere else.
  private buildOptions(): DatumBuilderOptions {
    const locale = this.localeValue ?? declaredDefaultLocale(this.seed.localization);
    return {
      componentTypes: this.paletteTypes(),
      componentDefinitions: this.mergedDefinitions(),
      initialRoot: this.seed.root,
      localization: this.seed.localization,
      // The map the Languages workspace edits: the controller commits it with the tree.
      translations: this.seed.translations,
      identity: {
        id: typeof this.seed.id === "string" ? this.seed.id : DEFAULT_FORM_IDENTITY.id,
        version: typeof this.seed.version === "string" ? this.seed.version : DEFAULT_FORM_IDENTITY.version,
        schemaVersion: typeof this.seed.schemaVersion === "string" ? this.seed.schemaVersion : DEFAULT_FORM_IDENTITY.schemaVersion
      },
      ...(locale ? { locale } : {}),
      ...this.canvasBindingOptions(),
      dataSources: this.previewDataSources(),
      dataSourceIds: this.dataSourceIdsValue,
      validationCodes: this.validationCodesValue,
      icons: this.iconsValue
    };
  }

  /**
   * The executor with the PDF theme on it: the `pdf-theme` attribute's theme over the
   * support's own, the page's PDF themes as the lookup for a layout's `theme` id unless
   * the support brings a registry, and the canvas binding's PDF suggestion for the ladder's
   * binding rung (read when a preview renders, so a binding picked later counts), as
   * `<datum-form>` passes it. A loader is wrapped so the theme lands when it resolves.
   */
  private themedSupport(source: PdfBuilderModeSupportSource): PdfBuilderModeSupportSource {
    const element = this;
    const dress = (support: PdfBuilderModeSupport): PdfBuilderModeSupport => ({
      ...support,
      theme: this.resolvedPdfTheme() ?? support.theme,
      themes: support.themes ?? this.themesValue.pdfLookup,
      get binding() {
        return element.canvasPdfSuggestion() ?? support.binding;
      }
    });
    return typeof source === "function" ? () => source().then(dress) : dress(source);
  }

  /**
   * The PDF theme the canvas binding suggests (`LiveBinding.pdfTheme`), or nothing when it
   * suggests none: the binding the author picked on the canvas, else the one `binding` names.
   */
  private canvasPdfSuggestion(): PdfBuilderModeSupport["binding"] {
    const value = this.bindingValue;
    const picked = this.controller?.bindingId();
    const own = typeof value === "object" && (picked === undefined || value.id === picked) ? value : undefined;
    const id = picked ?? (typeof value === "string" ? value : undefined);
    const binding = own ?? (id === undefined ? undefined : bindingById(id));
    return binding?.pdfTheme === undefined ? undefined : { id: binding.id, pdfTheme: binding.pdfTheme };
  }

  /** The `pdf-theme` attribute's theme; unset is `undefined`, a typo is reported once and ignored. */
  private resolvedPdfTheme(): PdfThemeDefinition | undefined {
    if (this.pdfThemeValue === undefined || this.pdfThemeValue === null) {
      return undefined;
    }
    const key = `pdf:${String(this.pdfThemeValue)}`;
    try {
      const theme = this.themesValue.resolvePdf(this.pdfThemeValue);
      this.unresolvedThemes.delete(key);
      return theme;
    } catch (error) {
      reportUnresolved(this, this.unresolvedThemes, key, error, "pdf-theme.unresolved");
      return undefined;
    }
  }

  /** What the canvas draws the form with: the binding and its files, and the bindings the picker offers. */
  private canvasBindingOptions(): Pick<DatumBuilderOptions, "binding" | "assets" | "availableBindings"> {
    if (this.loadFontsValue) {
      // The builder's own faces (the studio look).
      loadBuilderFonts(this.ownerDocument);
    }
    return {
      binding: this.bindingValue,
      assets: this.assetsValue,
      availableBindings: this.availableBindings()
    };
  }

  private loadSrc(url: string): void {
    const token = (this.srcToken += 1);
    this.srcLoading = true;
    this.editedWhileSrcLoads = false;
    fetchJson(url, () => this.maxDefinitionBytesValue).then(
      (json) => {
        if (token !== this.srcToken) {
          return;
        }
        this.srcLoading = false;
        if (this.editedWhileSrcLoads) {
          // The author's work is not replaced by a form that was only on its way.
          this.editedWhileSrcLoads = false;
          reportWarning(this, {
            code: "src.superseded",
            message: `The form from src (${url}) was not loaded: it arrived after the form was edited, and the edits are kept. Set src again to load it over them.`
          });
          return;
        }
        try {
          this.takeDefinition(toFormDefinition(json));
        } catch (error) {
          reportError(this, "definition.invalid", error instanceof Error ? error.message : String(error), error);
        }
      },
      (error: unknown) => {
        if (token === this.srcToken) {
          this.srcLoading = false;
          reportError(this, codeOf(error, "definition.load"), `Could not load the form from ${url}: ${error instanceof Error ? error.message : String(error)}`, error);
        }
      }
    );
  }
}

/** Whether two JSON values hold the same data, whatever order their objects' keys are in. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameData(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameData(left[key], right[key]));
}

/** `definition` with its `journey` block replaced, in place when it had one; `undefined` drops the key. */
/** Text for the status card's markup. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function withJourney(definition: FormDefinition, journey: JourneyConfiguration | undefined): FormDefinition {
  if (journey !== undefined) {
    return { ...definition, journey };
  }
  const { journey: _dropped, ...rest } = definition;
  return rest;
}

export function defineDatumFormBuilderElement(): void {
  if (!canDefineCustomElements() || customElements.get(DATUM_FORM_BUILDER_TAG)) {
    return;
  }
  customElements.define(DATUM_FORM_BUILDER_TAG, DatumFormBuilderElement);
}

declare global {
  interface HTMLElementTagNameMap {
    [DATUM_FORM_BUILDER_TAG]: DatumFormBuilderElement;
  }
}
