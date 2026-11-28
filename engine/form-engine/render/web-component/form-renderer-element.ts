import type { ComponentDefinition, DataSourceSet } from "../../core/schema/contracts.js";
import type { FieldInputState } from "../../core/schema/answer-kinds.js";
import { HTMLElementBase, adoptPreUpgradeProperties, canDefineCustomElements } from "./custom-element-base.js";
import { addressOf, resolveText } from "../../core/localization/translations.js";
import type { ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import { createFormTextResolver, type FormTextCatalog } from "../../core/localization/form-texts.js";
import type { FormNotice, FormNoticePlacement } from "../../core/submission/form-notice.js";
import { FormEventType, type SetValueOptions } from "../../core/events/event-types.js";
import type { JourneyNavigationResult } from "../../core/journey/journey-types.js";
import { LANGUAGE_SWITCHER_PART_TYPE, type FormChromeConfiguration } from "../../core/schema/form-chrome.js";
import type { RenderMode } from "../core/render-contracts.js";
import type { JourneyActionOutcome, JourneyActionPage } from "../../runtime/browser/journey/journey-action.js";
import { NoopJourneyRenderKit, type JourneyRenderKit } from "../core/journey-render-kit.js";
import { defaultJourneyRenderKit } from "../core/journey-render-kit-default.js";
import { parseFormFeatures, type FormFeature, type FormFeaturesInput } from "./form-features.js";
import type { RuntimeRenderOptions } from "../core/runtime-render-bridge.js";
import { DEFAULT_DATA_SOURCE_TIMEOUT_MS, timedDataSourceSet } from "../core/host-data-sources.js";
import type { FileStorageResolver } from "../core/file-storage.js";
// Print: the print model from the presentation fold, a print theme, the print frame.
import type { PrintPageSize, PrintRendition } from "../print/model.js";
import type { PrintTheme } from "../print/theme.js";
import type { PreparedPrint } from "../print/document.js";
import { readPrintConfiguration } from "../../core/schema/print.js";
import { findPdfLayout, readPdfConfiguration, readPdfLayoutCondition, type PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import type {
  PdfFontProvider,
  PdfImageResolver,
  PdfRenderProvider,
  PdfSigner,
  PdfTemplateResolver,
  PdfTimestamper
} from "../pdf/pdf-provider.js";
import type { PdfUnknownComponentPolicy } from "../pdf/pdf-abi.js";
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { RenderFormPdfOptions, RenderFormPdfResult } from "../pdf/pdf-service.js";
import type { PdfSignatureRequestSettings } from "../pdf/pdf-signer.js";
import type { PdfBindingSuggestion, PdfThemeDefinition, PdfThemeSource } from "../pdf/pdf-theme.js";
import { downloadPdf, type DownloadPdfOptions, type DownloadPdfResult } from "./pdf-download.js";
// The live renderer: the draw loop, the Datum binding and the renderer's modules.
import { BINDING_ERROR_EVENT, fieldCapabilitiesOf, type BindingErrorDetail, type BindingFactory, type LiveAssets, type LiveBinding, type LiveMode } from "../live/contract.js";
import { bindingAssetsById, bindingById, onBindingsChanged } from "../live/binding-registry.js";
import { componentDrawingOf, withComponentDrawing, type ComponentDrawing } from "../../plugins/component-adapters.js";
import { lit } from "../live/lit.js";
import type { FormNoticesFeature } from "../live/form-notices.js";
import type { JourneyPageFeature } from "../live/journey-page.js";
import {
  createDatumBinding,
  createDatumFeatures,
  mountLive,
  type CanvasHooks,
  type DatumBinding,
  type LiveFeature,
  type LiveForm,
  type LiveMountOptions,
  type LiveRuntime
} from "../live/renderer.js";

export const DATUM_FORM_RENDERER_TAG = "datum-form-renderer";

// The `features` model is one module for every element that reads the list; the engine
// root reaches it through this element's barrel, and `packages/datum` re-exports it.
export {
  AGENT_ACCESS_VALUES,
  DEFAULT_AGENT_ACCESS,
  FORM_FEATURES,
  FORM_FEATURE_PRESETS,
  FORM_OPT_IN_FEATURES,
  formFeatureOn,
  isOptInFormFeature,
  parseFormFeatures,
  type AgentAccess,
  type FormFeature,
  type FormFeaturesInput,
  type FormOptInFeature,
  type ParsedFormFeatures
} from "./form-features.js";

/**
 * A runtime as the renderer reads it when `journeys` is left out of `features`: the
 * same runtime with its journey readings taken away, so the render bridge, which treats a runtime
 * without them as one that runs no journey (the builder's preview), draws the whole form as the
 * one page it is. Every other member is the runtime's own, bound to it.
 */
const JOURNEY_READINGS: ReadonlySet<PropertyKey> = new Set(["journeyView", "journeyRenderRoot", "presentationIndex", "presentationValuePathOf"]);

function withoutJourneyReadings<R extends object>(runtime: R): R {
  return new Proxy(runtime, {
    get(target, property) {
      if (JOURNEY_READINGS.has(property)) {
        return undefined;
      }
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    }
  });
}

/** What goes with a `pdfSigner`: settings over the layout's `signature` block, and a timestamper. */
export interface PdfSignatureOptions {
  settings?: PdfSignatureRequestSettings | undefined;
  timestamper?: PdfTimestamper | undefined;
}

/**
 * The PDF pipeline, loaded on the first PDF and never before: an HTML renderer that
 * produces no PDF carries none of it, and a bundler splits it into its own chunk. One promise,
 * shared by every renderer element on the page.
 */
let pdfPipeline: Promise<typeof import("../pdf/pdf-service.js")> | undefined;

function loadPdfPipeline(): Promise<typeof import("../pdf/pdf-service.js")> {
  if (!pdfPipeline) {
    // A chunk that is not there (deleted from the server, blocked, a 404) rejects with a message
    // that names it, `name` "ChunkLoadError" for a host element to recognise, and is forgotten, so the next PDF asks the browser again instead of
    // replaying the cached failure.
    const load = import("../pdf/pdf-service.js").catch((error: unknown): never => {
      throw Object.assign(
        new Error(`The PDF service (datum-form-pdf-service-*.js) could not be loaded: ${error instanceof Error ? error.message : String(error)}`),
        { name: "ChunkLoadError", cause: error }
      );
    });
    load.catch(() => {
      if (pdfPipeline === load) {
        pdfPipeline = undefined;
      }
    });
    pdfPipeline = load;
  }
  return pdfPipeline;
}

/**
 * The print pipeline, loaded on the first `print()` and never before, as the PDF pipeline is: one
 * promise per page. A chunk that cannot be had rejects with a `ChunkLoadError` naming it and is
 * forgotten, so the next print asks the browser again.
 */
let printPipeline: Promise<typeof import("./print-pipeline.js")> | undefined;

function loadPrintPipeline(): Promise<typeof import("./print-pipeline.js")> {
  if (!printPipeline) {
    const load = import("./print-pipeline.js").catch((error: unknown): never => {
      throw Object.assign(
        new Error(`The print pipeline (datum-form-print-pipeline-*.js) could not be loaded: ${error instanceof Error ? error.message : String(error)}`),
        { name: "ChunkLoadError", cause: error }
      );
    });
    load.catch(() => {
      if (printPipeline === load) {
        printPipeline = undefined;
      }
    });
    printPipeline = load;
  }
  return printPipeline;
}

/** The Datum binding every element draws with when it names no other, and the fallback behind every other: one per page. */
let datumBindingInstance: DatumBinding | undefined;

function datumBinding(): DatumBinding {
  return (datumBindingInstance ??= createDatumBinding());
}

/**
 * A design-system binding made on this page: a package's `createBinding(lit, datum)` called with
 * the page's one lit namespace and Datum's binding, the one every element draws behind it. The
 * result is what `bindings.register` takes; a host with a binding package calls this, never
 * imports lit itself (the isolation guard keeps a second copy of lit out of the page).
 */
export function bindingFromFactory(factory: BindingFactory): LiveBinding {
  return factory(lit, datumBinding());
}

// The Datum binding with its seams set (tokens, the dark set, frames, parts, controls): a host's
// restyled Datum, given to an element as its `binding` or registered under an id of its own.
export {
  composeDatumOptions,
  createDatumBinding,
  type AdapterOverride,
  type ChromeOverride,
  type DatumBindingOptions,
  type DatumControls,
  type DatumFieldOrder,
  type DatumFrame
} from "../live/datum/options.js";
export type { DatumBinding } from "../live/renderer.js";
export type { DatumParts } from "../live/datum/parts.js";

/** What each runtime's list of component definitions draws with, so a redraw finds the same adapters (and the same binding). */
const drawingsByDefinitions = new WeakMap<readonly ComponentDefinition[], ComponentDrawing>();

/** One of the form's PDF layouts, as a picker lists it: its id and its name for the locale. */
export interface PdfLayoutOption {
  id: string;
  label: string;
  kind: PdfLayoutDocument["kind"];
  /** What a download that names no layout prints when no layout's `when` holds: the declared default, else the first. */
  isDefault: boolean;
  /**
   * The layout has a `when`: a download that names no layout may print it, by the
   * answers. A picker offers an automatic choice once any layout is conditional.
   */
  conditional: boolean;
}

/**
 * Detail of the `datum-form-action` event, dispatched when a `button` component is
 * activated. The renderer reports *intent* and never acts on it: performing a `"submit"`
 * (or a `"download"`, which is a submit whose accepted envelope then goes to
 * `downloadSubmission`) needs a submission-mode id and version context that only the host
 * knows (`FormRuntime.submit(modeId, versionContext)`). `action` is the raw configured
 * string, so a form authored against a newer action vocabulary still reaches the host's
 * dispatcher.
 */
export interface DatumFormActionDetail {
  /**
   * The button's component id. For a journey's own Submit, which is no component of
   * the form, the form root's, with {@link journey} saying which page it was pressed on.
   */
  componentId: string;
  action: string;
  /** The button's `signature` option: the signing provider id its submit should use, `"webauthn"` for a passkey. */
  signature?: string;
  /** Set when a journey's last page submits through its own Submit. */
  journey?: { journeyId: string; pageId: string };
}

/**
 * Detail of the cancelable `datum-print` event, dispatched by {@link DatumFormRendererElement.print}
 * before the dialog opens: the complete HTML the browser is about to print, the print theme it is
 * drawn with, and why the theme asked for was set aside for the basic one, when it was. A host
 * that calls `preventDefault()` takes the document over — to a PDF service, its own window — and
 * nothing prints (no frame is opened for a theme without a self-check; the one opened to check a
 * theme is removed).
 */
export interface DatumPrintDetail {
  html: string;
  /** The id of the print theme the document is drawn with. */
  theme: string;
  /** Why the print theme asked for could not print as it should: its self-check's problems, or a drawer it refused. */
  fellBack?: string[];
}

/** What a {@link DatumFormRendererElement.print} or {@link DatumFormRendererElement.preparePrintDocument} call asks for. */
export interface PrintCallOptions {
  /**
   * `answers`: what the person gave. `blank`: a paper form to fill in by hand. `filled`: the
   * paper form's look with the answers written in. Absent, the form's default rendition
   * (`configuration.print.defaultRendition`, else the first it offers, else `answers`); one the
   * form does not offer is still printed when asked for.
   */
  rendition?: PrintRendition;
  /** The paper: `auto` (the default) leaves the size to the print dialog; the margin is CSS lengths (default `16mm`). */
  page?: { size?: PrintPageSize; margin?: string };
  /** Print in this locale (a BCP 47 tag) rather than the one the form shows; the live form's locale is left as it is. */
  locale?: string;
}

/** The renditions a form offers a person ({@link DatumFormRendererElement.printRenditions}), and the one a print without a rendition asks for. */
export interface PrintRenditionsOffered {
  offered: PrintRendition[];
  default: PrintRendition;
}

/**
 * A print document built and not presented ({@link DatumFormRendererElement.preparePrintDocument}):
 * the complete HTML, the print model it is drawn from (`model.rendition`, `model.page` with its
 * running bands), the id of the print theme it is drawn with, and why the theme asked for was set
 * aside for the basic one (`fellBack`), when it was. `selfCheck` and `fallback` are what the print
 * frame runs once the document's sheets are in: a theme whose self-check fails is printed with the
 * basic theme's document instead.
 */
export type { PreparedPrint };

/**
 * Detail of `datum-locale-applied`, dispatched when a locale picked through the chrome's
 * language switcher (see `FormChromeConfiguration`) has been applied to the runtime.
 */
export interface DatumLocaleAppliedDetail {
  locale: string;
}

/**
 * Detail of `datum-locale-rejected`, dispatched when the runtime refused a locale picked
 * through the switcher — one outside the form's `supportedLocales`. The control has already
 * been put back to the locale the form is still in; `message` is the runtime's reason, for a
 * host that wants to show it.
 */
export interface DatumLocaleRejectedDetail {
  locale: string;
  message: string;
}

/**
 * The runtime the element draws: what the live renderer needs of it (`LiveRuntime`: its event bus,
 * its writes, `validatePath` for the leave-field check, `setDateParts` for a date typed part by
 * part, the definition for its `kinds` map) and what the renderer's modules drive (steps,
 * journeys, the language switch, data grid rows). `FormRuntime` satisfies it structurally; so
 * does the builder's preview runtime, which leaves the journey and navigation members out.
 */
export interface RenderHostRuntime extends LiveRuntime {
  /**
   * `path` is a *value path*, which is the component id for every component outside a
   * data-scoping `container` and `<container id>.<component id>` inside one. `FormRuntime`
   * parses it as a component path, so both forms work unchanged.
   */
  setValue(path: string, value: unknown, options?: SetValueOptions): void;
  /**
   * The control editing `path` has been left. Optional: a runtime without it
   * (the builder's preview) simply has no commit signal.
   */
  commitValue?(path: string): void;
  /**
   * What the control at `path` knows that the empty answer it writes cannot say: a
   * date typed in part, a number box the browser could not read; `undefined` forgets it.
   * Optional: a runtime without it (the builder's preview) reads such an answer as empty.
   */
  setInputState?(path: string, state: FieldInputState | undefined): void;
  /** What {@link setInputState} last recorded for `path`, while it still holds. Optional, as that is. */
  inputState?(path: string): FieldInputState | undefined;
  /**
   * The components whose Validate rule (`rules.validWhen`) does not hold, id -> `true`:
   * what builder Try it hands the field-constraints stage. `FormRuntime` and the builder's
   * preview have it; optional so a host's own runtime need not.
   */
  invalidMap?(): Record<string, boolean>;
  /**
   * The component definitions the runtime was built with: a host's or a plugin's own types, each
   * drawn by its `adapter` laid over the binding. `FormRuntime` has it; a runtime
   * without it (the builder's preview, whose canvas lays the controller's) draws none of them.
   */
  componentDefinitions?(): readonly ComponentDefinition[];
  /** With `scope`, only that component's subtree is checked (a multi-step form's Continue). */
  validate(options?: { scope?: string }): Promise<unknown>;
  /**
   * Moves a multi-step form to `stepId`, through the runtime's hooks and gating
   * rules; the `NAVIGATION_COMPLETED` it publishes redraws the form on the new step.
   * Optional: without it (the builder's preview) the steps switch in place.
   */
  navigate?(stepId: string): Promise<{ ok: boolean }>;
  /** Records a step as completed before Continue navigates on. Optional. */
  markStepCompleted?(stepId: string): void;
  /**
   * Switches the form's locale; the chrome's language switcher drives it. Expected to throw
   * for a locale the form does not support (as `FormRuntime.setLocale` does), which the
   * renderer reports as `datum-locale-rejected`.
   */
  setLocale(locale: string): void;
  /**
   * A journey's navigation: Continue checks the page and moves on, Back follows the
   * path, a jump opens a page at or before the furthest reached. The runtime decides and
   * publishes `PAGE_CHANGED`, which redraws the form on the new page; a refusal comes back as
   * `{ ok: false, reason }`. Optional: a runtime that runs no journey (the builder's preview)
   * leaves them out, and its `journeyView` with them.
   */
  nextPage?(): Promise<JourneyNavigationResult>;
  /**
   * What a journey page's action comes to (`FormRuntime.journeyAction`): Continue on a page that
   * is not the last, else the page's own submit button, else the journey's Submit. Optional like
   * the navigation above, which it belongs with.
   */
  journeyAction?(page: JourneyActionPage): Promise<JourneyActionOutcome>;
  previousPage?(): Promise<JourneyNavigationResult>;
  goToPage?(pageId: string, options?: { direction?: "jump" | "error" | "change" }): Promise<JourneyNavigationResult>;
  /**
   * A data grid's row buttons: Add appends an empty row, Remove drops
   * one, Move up / Move down swap it with its neighbour; the runtime publishes
   * `COLLECTION_CHANGED` and the form is drawn again. Optional: under a runtime without them
   * the buttons are drawn and do nothing when pressed.
   */
  addRow?(collectionPath: string, row?: Record<string, unknown>): number;
  removeRow?(collectionPath: string, rowIndex: number): void;
  reorderRow?(collectionPath: string, fromIndex: number, toIndex: number): void;
  /**
   * Each data grid's row-count bounds as of the last recompute, its `rules.minRows` /
   * `rules.maxRows` laid over its fixed ones (`FormRuntime.dataGridRowBounds`): what
   * Add and Remove are disabled at. Optional: without it the configuration's bounds stand.
   */
  dataGridRowBounds?(): Record<string, { minRows: number; maxRows: number | undefined }>;
}

const CARET_INPUT_TYPES = new Set(["text", "", "search", "email", "tel", "url", "password", "number"]);

/**
 * A control typed into with a caret, whose `input` events are keystrokes on the way to a
 * value rather than the value itself. A radio, a date picker or a range slider
 * reports a finished choice on `input`. Exported for the agent host's focused-field rule,
 * which must share this test rather than copy it.
 */
export function isCaretControl(target: HTMLElement): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && CARET_INPUT_TYPES.has(target.type))
  );
}

/** A binding as the element was given it: an object, an id registered with `registerBinding`, or nothing (Datum's). */
export type FormRendererBinding = LiveBinding | string;

/** The element's `mode`: the live renderer's, plus `"pdf"`, which draws as `"readonly"` (a PDF is the PDF pipeline's to make). */
export type FormRendererMode = LiveMode | RenderMode;

/** The live renderer's mode for the element's. */
function liveModeOf(mode: FormRendererMode): LiveMode {
  return mode === "pdf" ? "readonly" : mode;
}

/** Whether constructed sheets can be adopted into `root` (jsdom has the class but no `adoptedStyleSheets`). */
function canAdopt(root: ShadowRoot): boolean {
  return (
    typeof CSSStyleSheet === "function" &&
    Array.isArray((root as { adoptedStyleSheets?: unknown }).adoptedStyleSheets) &&
    typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync === "function"
  );
}

/**
 * `<datum-form-renderer>`: a form drawn by the live renderer. The element mounts the
 * runtime it is given into its shadow root with `mountLive`, through a binding (Datum's unless the
 * host names another) and the renderer's modules (`createDatumFeatures`, plus the journey kit's
 * page module for a journey): one lit-html update step per runtime change, nodes kept between
 * draws, so focus, the caret, an input method's composition and a design system's component state
 * stay where they are without being put back.
 *
 * The element owns what a host configures and the public surface hosts and the agent layer use:
 * the `features` gate, the binding and its assets, the wording, the host's chrome,
 * notice and submit state, data sources, files, the PDF and print. Everything about drawing,
 * input, focus, read-only, journeys, steps, tabs, data grids, files and the language switch is
 * the renderer's (`render/live/`).
 *
 * Settings the renderer reads at every build or draw (the wording, the chrome, the notice, the
 * canvas hooks, the colour scheme) take effect on the next draw; settings a mount is made from
 * (the runtime, the binding and its assets, the mode, the features, the journey kit) mount the
 * form again, once per task however many changed.
 */
export class DatumFormRendererElement extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ["features"];
  }

  /** The features that exist; `undefined`, the attribute absent, is every one. */
  private featuresValue: ReadonlySet<FormFeature> | undefined;
  /** Features already warned about as asked-for-but-left-out: once each, until the list changes. */
  private readonly warnedFeatures = new Set<FormFeature>();
  private readonly root: ShadowRoot;
  private runtimeRef: RenderHostRuntime | undefined;
  private modeValue: FormRendererMode = "interactive";
  private bindingValue: FormRendererBinding | undefined;
  /** The binding id last reported as registered by no one, so a remount does not report it again. */
  private reportedBindingId: string | undefined;
  private assetsValue: LiveAssets | undefined;
  private canvasHooksValue: CanvasHooks | undefined;
  private colorSchemeValue: "light" | "dark" | undefined;
  private messagesValue: ValidationMessageCatalog | undefined;
  private textsValue: FormTextCatalog | undefined;
  private noticeValue: FormNotice | undefined;
  private pageRedirectedValue = false;
  private submittingValue = false;
  private submittingPlacementValue: FormNoticePlacement[] | undefined;
  private errorSummaryPlacementValue: FormNoticePlacement[] | undefined;
  /** How a collection-bound container draws its rows. */
  private dataGridRowsValue: "entries" | "template" | undefined;
  private chromeValue: FormChromeConfiguration | undefined;
  private headingLevelValue: number | undefined;
  private dataSourcesValue: DataSourceSet | undefined;
  /** {@link dataSourcesValue} under {@link dataSourceTimeoutValue}, made once per change of either. */
  private timedSources: DataSourceSet | undefined;
  private journeyKitValue: JourneyRenderKit | undefined;
  /** Whether the first draw waits for the data sources (see {@link dataSourceWait}). */
  private dataSourceWaitValue: "none" | "all" = "none";
  private dataSourceTimeoutValue: number = DEFAULT_DATA_SOURCE_TIMEOUT_MS;
  private fileStorageValue: FileStorageResolver | undefined;
  private pdfProviderValue: PdfRenderProvider | undefined;
  private pdfFontsValue: PdfFontProvider | undefined;
  private pdfTemplatesValue: PdfTemplateResolver | undefined;
  private pdfImagesValue: PdfImageResolver | undefined;
  private pdfThemeValue: PdfThemeDefinition | undefined;
  private pdfThemesValue: PdfThemeSource | undefined;
  private pdfUnknownComponentsValue: PdfUnknownComponentPolicy | undefined;
  private formulaErrorsValue: FormulaErrorPolicy | undefined;
  private riskyPatternsValue: "refuse" | "allow" | undefined;
  private pdfSignerValue: PdfSigner | undefined;
  private pdfSignatureValue: PdfSignatureOptions | undefined;
  private extraStylesValue = "";
  private showHiddenValue = false;

  /** The mounted form, while the element is on the page with a runtime. */
  private liveForm: LiveForm | undefined;
  /** The binding the mounted form is drawn by. */
  private mountedBinding: LiveBinding | undefined;
  /** The design system's files the mounted form was drawn with: the element's own, else the registered binding's. */
  private mountedAssets: LiveAssets | undefined;
  /** The journey page module of the mounted form (a journey kit's), for an agent's quiet page move. */
  private journeyPage: JourneyPageFeature | undefined;
  /** Quiet moves in flight ({@link quietNextPageFocus}), and the refusals they let through that the summary may not focus. */
  private quietFocusCount = 0;
  private swallowedErrorFocus = 0;
  /** The receipt module of the mounted form, for {@link focusNotice}. */
  private notices: FormNoticesFeature | undefined;
  /** A mount asked for and not yet made: one per task, however many settings changed. */
  private mountQueued = false;
  /** Settles once the mount queued last has been made (or found nothing to mount). */
  private mounting: Promise<void> = Promise.resolve();
  /** The host's extra rules (`extraStyles`), adopted after the binding's. */
  private extraSheet: CSSStyleSheet | undefined;
  private extraStyleElement: HTMLStyleElement | undefined;
  /** The line shown while there is no form to show yet (see {@link showLoading}). */
  private loadingLine: HTMLParagraphElement | undefined;
  /** Stops hearing the binding registry. */
  private stopBindings: (() => void) | undefined;
  /** Orders overlapping {@link print} calls. */
  private printToken = 0;
  /** The frame the last {@link print} presented, kept until its `afterprint` (see there). */
  private printFrame: HTMLIFrameElement | undefined;
  /** The print theme {@link print} draws with; the basic one when unset. */
  private printThemeValue: PrintTheme | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  public attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "features") {
      this.features = value === null ? undefined : value;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  public connectedCallback(): void {
    adoptPreUpgradeProperties(this);
    // A binding registered (or replaced) under the id this element names is drawn with at once.
    this.stopBindings ??= onBindingsChanged(() => {
      if (typeof this.bindingValue === "string" && this.liveForm !== undefined && (this.drawingBinding() !== this.mountedBinding || this.drawnAssets() !== this.mountedAssets)) {
        this.reportedBindingId = undefined;
        this.scheduleMount();
      }
    });
    // An element moved within one task keeps the form it had (see `disconnectedCallback`).
    if (!this.liveForm) {
      this.showLoading();
      this.scheduleMount();
    }
  }

  /**
   * The line said while there is no form to show yet (no runtime, or the first draw not ready:
   * a data source the host waits for, a design system's sheet being fetched): the `loading` form
   * text, worded like the rest of the form (the host's texts, the form's translations, the
   * binding's pack, the engine's English). Gone once the form is shown, or once an alert takes its
   * place.
   */
  private showLoading(): void {
    const runtime = this.runtimeRef;
    const binding = this.drawingBinding();
    const pack = binding.texts !== undefined || binding.messages !== undefined ? { texts: binding.texts, messages: binding.messages } : undefined;
    const words = createFormTextResolver(runtime?.state().locale ?? "en", this.textsValue, undefined, {
      translations: runtime?.translations?.(),
      catalog: runtime?.translationCatalog?.(),
      ...(pack ? { pack } : {})
    });
    const line = (this.loadingLine ??= this.ownerDocument.createElement("p"));
    line.setAttribute("data-datum-loading", "");
    line.textContent = words("loading");
    if (!line.isConnected) {
      this.root.prepend(line);
    }
  }

  private hideLoading(): void {
    this.loadingLine?.remove();
  }

  public disconnectedCallback(): void {
    this.stopBindings?.();
    this.stopBindings = undefined;
    // An element only moved (taken out and put back in the same task) keeps its form.
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.unmountLive();
        // Not on a runtime swap: that must not pull the document out from under an open print
        // dialog, but an element leaving the page has nothing left to print. A print still
        // being built or waiting on its sheets is superseded, so it opens no dialog and
        // removes the frame it made.
        this.printToken++;
        this.printFrame?.remove();
        this.printFrame = undefined;
      }
    });
  }

  /** Mounts the form again (once per task): after a setting a mount is made from changed. */
  private scheduleMount(): void {
    if (this.mountQueued) {
      return;
    }
    this.mountQueued = true;
    this.mounting = new Promise<void>((done) => {
      queueMicrotask(() => {
        this.mountQueued = false;
        try {
          this.mountNow();
        } catch (thrown) {
          this.reportDrawError(thrown);
        } finally {
          done();
        }
      });
    });
  }

  private unmountLive(): void {
    const live = this.liveForm;
    this.liveForm = undefined;
    this.mountedBinding = undefined;
    this.mountedAssets = undefined;
    this.journeyPage = undefined;
    this.notices = undefined;
    if (live) {
      // A remount (the element still on the page: a setting changed) commits the answer being
      // typed first, so the runtime and the host hear it as when the person leaves the box.
      if (this.isConnected) {
        live.settleInput();
      }
      live.unmount();
    }
    this.extraStyleElement?.remove();
    this.extraStyleElement = undefined;
    if (this.extraSheet && canAdopt(this.root)) {
      this.root.adoptedStyleSheets = this.root.adoptedStyleSheets.filter((sheet) => sheet !== this.extraSheet);
    }
  }

  private mountNow(): void {
    this.unmountLive();
    const runtime = this.runtimeRef;
    if (!this.isConnected) {
      return;
    }
    this.showLoading();
    if (!runtime) {
      return;
    }
    this.noteLeftOut();
    const binding = this.drawingBinding(true);
    const datum = this.drawingDatum();
    const drawnAssets = this.drawnAssets();
    const kit = this.drawnJourneyKit();
    const journeyPage = this.allows("journeys") ? kit.pageFeature?.() : undefined;
    const features = createDatumFeatures((binding as Partial<DatumBinding>).options ?? {}, {
      chrome: {
        chrome: () => this.chromeValue,
        translations: () => this.allows("translations"),
        headingLevel: () => this.headingLevelValue ?? 1
      },
      formNotices: {
        notice: () => this.noticeValue,
        submittingPlacement: () => this.submittingPlacementValue,
        headingLevel: () => this.headingLevelValue ?? 1
      },
      files: { storage: () => this.fileStorageValue },
      summary: { placement: () => this.errorSummaryPlacementValue, headingLevel: () => this.headingLevelValue ?? 1 }
    });
    this.notices = features.find((feature): feature is FormNoticesFeature => feature.id === "form-notices" && typeof (feature as Partial<FormNoticesFeature>).focusNotice === "function");
    this.journeyPage = journeyPage;
    const element = this;
    const options: LiveMountOptions = {
      runtime: this.drawnRuntime(runtime),
      binding,
      datum,
      ...(drawnAssets ? { assets: drawnAssets } : {}),
      mode: liveModeOf(this.modeValue),
      // The quiet module first: it may keep the summary from taking focus (see quietNextPageFocus).
      features: [this.quietFeature(), ...features, ...(journeyPage ? [journeyPage] : []), this.hostFeature(journeyPage)],
      host: this,
      journeyKit: kit,
      // Read at every build or draw: a setter asks for one (`request`, `redraw`) rather than mounting again.
      get messages() {
        return element.messagesValue;
      },
      get texts() {
        return element.textsValue;
      },
      get dataSources() {
        return element.drawnDataSources();
      },
      get dataSourceWait() {
        return element.dataSourceWaitValue;
      },
      get canvasHooks() {
        return element.canvasHooksValue;
      },
      get colorScheme() {
        return element.colorSchemeValue;
      },
      get dataGridRows() {
        return element.dataGridRowsValue;
      },
      get includeHidden() {
        return element.showHiddenValue;
      },
      get headingLevel() {
        return element.headingLevelValue;
      }
    };
    const live = mountLive(this.root, options);
    this.liveForm = live;
    this.mountedBinding = binding;
    this.mountedAssets = drawnAssets;
    this.applyExtraStyles();
    live.ready.then(
      () => {
        if (this.liveForm === live) {
          this.hideLoading();
        }
      },
      (thrown: unknown) => {
        // The renderer drew an alert in the form's place and said why (`datum-binding-error`); the
        // host's general error channel hears it too.
        if (this.liveForm === live) {
          this.hideLoading();
          this.reportDrawError(thrown);
        }
      }
    );
  }

  /**
   * The element's own module of the mounted form: what it applies once the form starts (a
   * submission already in flight, the journey's redirect line) and what it hears (a page change
   * ends the redirect line).
   */
  private hostFeature(journeyPage: JourneyPageFeature | undefined): LiveFeature {
    return {
      id: "form-renderer-element",
      start: (live) => {
        if (this.submittingValue) {
          live.setBusy("submitting", true);
        }
        if (this.pageRedirectedValue) {
          journeyPage?.setPageRedirected(true);
        }
        return live.runtime.events().subscribe(FormEventType.PAGE_CHANGED, () => {
          this.pageRedirectedValue = false;
        });
      }
    };
  }

  /**
   * The module that keeps the summary from taking focus for a refused submit made while the page
   * is quiet ({@link quietNextPageFocus}, an agent's): the errors are drawn, and one refusal
   * swallows one focus. First in the list, so it answers before the summary does.
   */
  private quietFeature(): LiveFeature {
    return {
      id: "form-renderer-element-quiet",
      start: (live) => {
        const stop = live.runtime.events().subscribe(FormEventType.SUBMISSION_FAILED, () => {
          if (this.quietFocusCount > 0) {
            this.swallowedErrorFocus += 1;
          }
        });
        return () => {
          stop();
          this.swallowedErrorFocus = 0;
        };
      },
      focusErrors: () => {
        if (this.swallowedErrorFocus > 0) {
          this.swallowedErrorFocus -= 1;
          return true;
        }
        return false;
      }
    };
  }

  /** Tells the host the form could not be drawn: the console, and a `datum-error` it can listen for. */
  private reportDrawError(error: unknown): void {
    console.error("[datum-form-renderer] The form could not be drawn", error);
    this.dispatchEvent(
      new CustomEvent("datum-error", {
        detail: { code: "render.failed", message: error instanceof Error ? error.message : String(error), cause: error },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * The host's extra rules as the last sheet of the shadow root (after the binding's and the
   * design system's), or, where sheets cannot be adopted, a `<style>` after the renderer's own.
   */
  private applyExtraStyles(): void {
    const css = this.extraStylesValue;
    if (!this.liveForm) {
      return;
    }
    if (canAdopt(this.root)) {
      const others = this.root.adoptedStyleSheets.filter((sheet) => sheet !== this.extraSheet);
      if (css === "") {
        this.root.adoptedStyleSheets = others;
        return;
      }
      this.extraSheet ??= new CSSStyleSheet();
      try {
        this.extraSheet.replaceSync(css);
      } catch (thrown) {
        console.error("[datum-form-renderer] extraStyles could not be adopted", thrown);
        return;
      }
      this.root.adoptedStyleSheets = [...others, this.extraSheet];
      return;
    }
    if (css === "") {
      this.extraStyleElement?.remove();
      this.extraStyleElement = undefined;
      return;
    }
    const style = (this.extraStyleElement ??= this.ownerDocument.createElement("style"));
    style.setAttribute("data-datum-extra", "");
    style.textContent = css;
    if (!style.isConnected) {
      // After the renderer's own sheets, before the form lit draws (children, not `:scope`, which jsdom reads nothing under in a shadow root).
      const own = Array.from(this.root.children).filter((child) => child.matches("style[data-datum-live]"));
      const last = own.at(-1);
      if (last) {
        last.after(style);
      } else {
        this.root.prepend(style);
      }
    }
  }

  // ── Features ────────────────────────────────────────────────────────────────────

  /**
   * The optional capabilities this renderer has, read as `<datum-form>` reads them:
   * `journeys`, `print`, `translations`, `data-sources`, `drafts`, `server-validation`,
   * `signing`, `pdf`, `wasm`, with the presets `all` and `minimal`; as the `features` attribute,
   * tokens separated by spaces or commas, the property taking the same string or an array.
   * Absent (`undefined`), every capability is there for the properties that configure it, as it
   * always was. Present, only the listed ones: what the page set for a left-out capability is
   * ignored with one console warning, its methods reject naming it, and its code is never
   * loaded. Here that is `pdf` (`renderPdf`, `downloadPdf`, `pdfLayouts`, the PDF properties,
   * and the PDF pipeline chunk), `print` (`print()`), `journeys` (a runtime's journey is drawn
   * as the one page the form is), `translations` (the language switcher and locale switching),
   * `data-sources` (the `dataSources` property) and `signing` (`pdfSigner`). `drafts`,
   * `server-validation` and `wasm` belong to the runtime a host builds, not to this element, and
   * are accepted with nothing to gate. A word that names nothing is reported as `datum-error`
   * and left out (a typo can only narrow what exists). Reads back the list that applies, in a
   * fixed order. Changing it to a different list mounts the form again, the answer being typed
   * committed first; the same list set again changes nothing. `agent` (the WebMCP agent tools)
   * is opt-in: not part of `all` and never implied by an absent list, so only `features="all
   * agent"` (or any list naming it) turns it on; this element accepts the token and gates
   * nothing with it.
   */
  public get features(): readonly FormFeature[] | undefined {
    return this.featuresValue ? [...this.featuresValue] : undefined;
  }

  public set features(value: FormFeaturesInput | undefined) {
    let next: Set<FormFeature> | undefined;
    if (value !== undefined && value !== null) {
      const parsed = parseFormFeatures(value);
      next = new Set(parsed.features);
      if (parsed.unknown.length > 0) {
        const message = `features names no such feature or preset: ${parsed.unknown.map((word) => `"${word}"`).join(", ")}`;
        console.error(`[${DATUM_FORM_RENDERER_TAG}] ${message}`);
        this.dispatchEvent(new CustomEvent("datum-error", { detail: { code: "features.unknown", message }, bubbles: true, composed: true }));
      }
    }
    // The same list again (a host writes the attribute on every set of its own) changes nothing:
    // no mount, so the answer being typed and the person's focus stay.
    const previous = this.featuresValue;
    if (previous === undefined ? next === undefined : next !== undefined && next.size === previous.size && [...next].every((feature) => previous.has(feature))) {
      return;
    }
    this.featuresValue = next;
    this.warnedFeatures.clear();
    this.timedSources = undefined;
    this.scheduleMount();
  }

  /** Whether the `features` list (when there is one) has `feature`. */
  private allows(feature: FormFeature): boolean {
    return this.featuresValue === undefined || this.featuresValue.has(feature);
  }

  /**
   * Something the page asked of a feature the list leaves out: ignored, with one console warning
   * per feature (never a throw, never a `datum-error`: the page wrote the list).
   */
  private ignoreLeftOut(feature: FormFeature, asked: string): void {
    if (this.warnedFeatures.has(feature)) {
      return;
    }
    this.warnedFeatures.add(feature);
    console.warn(`[${this.tagName.toLowerCase()}] Ignoring ${asked}: the features list does not include "${feature}".`);
  }

  /** The error a method of a left-out feature fails with. */
  private leftOut(feature: FormFeature, what: string): Error {
    return new Error(`${what} is not available: the features list of this <${this.tagName.toLowerCase()}> does not include "${feature}"`);
  }

  /**
   * Warns, once per feature, of what the page has already set for a feature the list leaves out.
   * Run when the form is mounted (after the list changes, a runtime is handed over) and by the
   * setters that switch a capability on, so the order the page sets things in does not matter.
   * Free when the attribute is absent.
   */
  private noteLeftOut(): void {
    if (this.featuresValue === undefined) {
      return;
    }
    if (!this.allows("pdf") && this.pdfProviderValue !== undefined) {
      this.ignoreLeftOut("pdf", "the pdfProvider and the other pdf settings");
    }
    if (!this.allows("signing") && this.pdfSignerValue !== undefined) {
      this.ignoreLeftOut("signing", "the pdfSigner setting");
    }
    if (!this.allows("data-sources") && this.dataSourcesValue !== undefined) {
      this.ignoreLeftOut("data-sources", "the dataSources setting");
    }
    if (!this.allows("translations") && this.chromeValue !== undefined && JSON.stringify(this.chromeValue).includes(`"${LANGUAGE_SWITCHER_PART_TYPE}"`)) {
      this.ignoreLeftOut("translations", "the language switcher in chrome");
    }
    if (!this.allows("journeys") && this.runtimeRef?.journeyView?.() !== undefined) {
      this.ignoreLeftOut("journeys", "the runtime's journey");
    }
  }

  /** The runtime as the renderer should read it: a journey's page is the whole form when `journeys` is left out. */
  private drawnRuntime(runtime: RenderHostRuntime): RenderHostRuntime {
    return this.allows("journeys") ? runtime : withoutJourneyReadings(runtime);
  }

  /** What draws a journey page: the kit the host handed over (else the page's default), or, with `journeys` left out, the Noop one (the form whole). */
  private drawnJourneyKit(): JourneyRenderKit {
    return this.allows("journeys") ? (this.journeyKitValue ?? defaultJourneyRenderKit()) : NoopJourneyRenderKit;
  }

  /** The host's data sources under their timeout; none when `data-sources` is left out. */
  private drawnDataSources(): DataSourceSet | undefined {
    if (!this.dataSourcesValue || !this.allows("data-sources")) {
      return undefined;
    }
    return (this.timedSources ??= timedDataSourceSet(this.dataSourcesValue, this.dataSourceTimeoutValue));
  }

  // ── The runtime and how it is drawn ────────────────────────────────────────────────────────

  public set runtime(value: RenderHostRuntime | undefined) {
    if (value === this.runtimeRef) {
      return;
    }
    this.runtimeRef = value;
    if (!value) {
      // Nothing to draw: the form goes now, not a task later.
      this.unmountLive();
    }
    this.scheduleMount();
  }

  public get runtime(): RenderHostRuntime | undefined {
    return this.runtimeRef;
  }

  /**
   * `interactive` (the default), `readonly` (every answer shown, none taken) or `disabled`.
   * `pdf` draws as `readonly`: a PDF is the PDF pipeline's to make ({@link renderPdf}). Mounts the
   * form again.
   */
  public set mode(value: FormRendererMode) {
    if (value === this.modeValue) {
      return;
    }
    this.modeValue = value;
    this.scheduleMount();
  }

  public get mode(): FormRendererMode {
    return this.modeValue;
  }

  /**
   * What draws the form's leaves: a binding object (`createBinding(lit, datum)` of a
   * design system's package, or `createDatumBinding({...})` with Datum's seams set), the id of one
   * registered on the page (`registerBinding`, the web components' `bindings.register`), or
   * nothing for the Datum binding. Datum's adapters stand behind every binding, drawing what it does
   * not. An id nothing has registered is reported as `datum-binding-error` (`hook: "binding"`)
   * and the form is drawn by Datum's binding meanwhile; registering it later draws it at once.
   * Mounts the form again.
   */
  public set binding(value: FormRendererBinding | undefined) {
    if (value === this.bindingValue) {
      return;
    }
    this.bindingValue = value;
    this.reportedBindingId = undefined;
    this.scheduleMount();
  }

  public get binding(): FormRendererBinding | undefined {
    return this.bindingValue;
  }

  /** The binding the form is drawn by now (the one named, else Datum's): what a host or the agent layer reads the id and language pack from. */
  public get drawnBinding(): LiveBinding {
    return this.drawingBinding();
  }

  /**
   * The binding the form is drawn by: the one chosen ({@link chosenBinding}) with the runtime's own
   * component types laid over it (`ComponentDefinition.adapter`, their `css` after the binding's).
   * The same object while neither changes. With `report`, as {@link chosenBinding}.
   */
  private drawingBinding(report = false): LiveBinding {
    return withComponentDrawing(this.chosenBinding(report), this.runtimeDrawing());
  }

  /**
   * Datum's binding as the fallback behind the one drawn, with the runtime's own types laid over
   * it too, so a type of the host's draws where the binding's adapter throws; their `css` is the
   * drawn binding's alone. The drawn binding itself while that is Datum's.
   */
  private drawingDatum(): LiveBinding {
    const datum = datumBinding();
    return withComponentDrawing(datum, this.runtimeDrawing(), { css: this.chosenBinding() === datum });
  }

  /** The drawing the runtime's component definitions bring, cached per list of definitions. */
  private runtimeDrawing(): ComponentDrawing | undefined {
    const definitions = this.runtimeRef?.componentDefinitions?.();
    if (definitions === undefined || definitions.length === 0) {
      return undefined;
    }
    let drawing = drawingsByDefinitions.get(definitions);
    if (drawing === undefined) {
      drawing = componentDrawingOf(definitions, { lit, datum: datumBinding() });
      drawingsByDefinitions.set(definitions, drawing);
    }
    return drawing;
  }

  /**
   * The binding chosen for the form: the one given, the one registered under the id given, else
   * Datum's. With `report`, an id no one registered is said once (`datum-binding-error`).
   */
  private chosenBinding(report = false): LiveBinding {
    const value = this.bindingValue;
    if (value === undefined || value === "datum") {
      return datumBinding();
    }
    if (typeof value !== "string") {
      return value;
    }
    const registered = bindingById(value);
    if (registered) {
      return registered;
    }
    if (report && this.reportedBindingId !== value) {
      this.reportedBindingId = value;
      const detail: BindingErrorDetail = { hook: "binding", id: value, message: `no binding is registered under "${value}"; the form is drawn by Datum's binding` };
      console.error(`[${DATUM_FORM_RENDERER_TAG}] ${detail.message}`);
      this.dispatchEvent(new CustomEvent(BINDING_ERROR_EVENT, { detail, bubbles: true, composed: true }));
    }
    return datumBinding();
  }

  /**
   * The design system's files as the host serves them: stylesheets and fonts the
   * renderer fetches, rewrites for the shadow root and adopts, and scripts it loads, each with its
   * integrity checked. A stylesheet that cannot be fetched draws an alert in the form's place.
   * Never needed for the Datum binding, whose sheet is bundled. Mounts the form again.
   */
  public set assets(value: LiveAssets | undefined) {
    if (value === this.assetsValue) {
      return;
    }
    this.assetsValue = value;
    this.scheduleMount();
  }

  public get assets(): LiveAssets | undefined {
    return this.assetsValue;
  }

  /**
   * The design system's files the form is drawn and printed with: the element's own `assets`,
   * else, for a binding named by its registered id, the files it was registered with
   * (`bindings.register(binding, { assets })`). Datum's binding needs none.
   */
  private drawnAssets(): LiveAssets | undefined {
    if (this.assetsValue !== undefined) {
      return this.assetsValue;
    }
    const value = this.bindingValue;
    const id = typeof value === "string" ? value : value?.id;
    return id === undefined || (typeof value === "object" && bindingById(id) !== value) ? undefined : bindingAssetsById(id);
  }

  /**
   * The host page's colour scheme: `dark` draws the binding's dark look where it has one (Datum's
   * dark token set); left out, light. Draws again.
   */
  public set colorScheme(value: "light" | "dark" | undefined) {
    const next = value === "dark" || value === "light" ? value : undefined;
    if (next === this.colorSchemeValue) {
      return;
    }
    this.colorSchemeValue = next;
    this.liveForm?.redraw();
  }

  public get colorScheme(): "light" | "dark" | undefined {
    return this.colorSchemeValue;
  }

  /**
   * The builder canvas's hooks, template-typed: `decorateField` wraps a field's drawing
   * (selection, drop targets), `renderContainer` draws a container in place of its adapter's
   * drawing given each slot drawn, `emptySlot` draws an empty slot (a drop zone). Set, every
   * paged container (steps) only shows the step a control names, and tabs keep their strip at
   * every width: the author is reaching each panel's drop zones. Draws again.
   */
  public set canvasHooks(value: CanvasHooks | undefined) {
    if (value === this.canvasHooksValue) {
      return;
    }
    this.canvasHooksValue = value;
    this.liveForm?.redraw();
  }

  public get canvasHooks(): CanvasHooks | undefined {
    return this.canvasHooksValue;
  }

  /** The mounted form (`render/live`'s `LiveForm`): which adapter drew a node, what the binding does not draw. */
  public get live(): LiveForm | undefined {
    return this.liveForm;
  }

  /**
   * The drawing capabilities this element's binding answers for a field type or a data grid (Datum's adapter
   * behind it), read through the definition's `kinds` map: what the builder's inspector offers.
   * `undefined` for a type nothing draws.
   */
  public capabilitiesOf(type: string): ReturnType<typeof fieldCapabilitiesOf> {
    return fieldCapabilitiesOf(this.drawingBinding(), this.drawingDatum(), type, this.runtimeRef?.definition?.().kinds);
  }

  // ── Wording ────────────────────────────────────────────────────────────────────────────────

  public set messages(value: ValidationMessageCatalog | undefined) {
    this.messagesValue = value;
    this.liveForm?.request();
  }

  public get messages(): ValidationMessageCatalog | undefined {
    return this.messagesValue;
  }

  /**
   * The page's wording for the form's own text (see `FormTextCatalog`), over the form's
   * translations and the binding's language pack. Unset, those, then the engine's English.
   */
  public set texts(value: FormTextCatalog | undefined) {
    this.textsValue = value;
    if (this.loadingLine?.isConnected) {
      this.showLoading();
    }
    this.liveForm?.request();
  }

  public get texts(): FormTextCatalog | undefined {
    return this.textsValue;
  }

  // ── The host's notice and submission ───────────────────────────────────────────────────────

  /**
   * The host's receipt after a delivered submission, drawn where the error summary
   * goes, after the fields, or both (its `placement`), and carried into the printed form.
   * Draws again; {@link focusNotice} moves focus to it, the way `focusFirstError` moves to the
   * summary.
   */
  public set notice(value: FormNotice | undefined) {
    this.noticeValue = value;
    this.liveForm?.redraw();
  }

  public get notice(): FormNotice | undefined {
    return this.noticeValue;
  }

  /**
   * Whether the journey page drawn is where the person was put after the page asked for was
   * refused: a polite status line (the `pageRedirected` text) under its heading, until the
   * next navigation (a `PAGE_CHANGED` clears it).
   */
  public set pageRedirected(value: boolean) {
    const next = value === true;
    if (this.pageRedirectedValue === next) {
      return;
    }
    this.pageRedirectedValue = next;
    this.journeyPage?.setPageRedirected(next);
  }

  public get pageRedirected(): boolean {
    return this.pageRedirectedValue;
  }

  /**
   * The next journey page change moves no focus and scrolls nothing (an
   * agent never takes focus from where the person left it, outside the form). Called just before
   * an agent's page move or submit; the page still draws, once, as any page change does. While
   * focus is inside this form it sits on the page being left, which the move removes, so nothing
   * is quieted and the new page takes focus as for the person's own move. One-shot: the next
   * `PAGE_CHANGED` uses it up; the returned release ends it unused, and the caller calls it once
   * its runtime call settles, so a refused move leaves no quiet behind. The person's own Continue
   * or Back ends it too. The journey page module does it. Until the returned release, a submit the
   * runtime refuses draws its errors and the summary does not take focus for them, wherever focus
   * is: the person may be typing in a field of this form, which only a page move removes.
   *
   * @internal
   */
  public quietNextPageFocus(): () => void {
    // The page module keeps its own rule: focus inside the form is on the page the move removes.
    const releasePage = this.journeyPage?.quietNextPageFocus() ?? (() => undefined);
    if (this.liveForm === undefined) {
      return releasePage;
    }
    this.quietFocusCount += 1;
    let released = false;
    return () => {
      releasePage();
      if (!released) {
        released = true;
        this.quietFocusCount -= 1;
      }
    };
  }

  /**
   * Whether a submission is in flight. On, the form draws busy — `aria-busy`, a
   * status line worded from {@link texts}, the fields `inert` — and takes no answer, for a browser
   * without `inert`. Off again, focus returns to the control that had it when the lock came (the
   * submit button, as a rule), unless something took it meanwhile: the first error, a notice. A
   * host sets it around its own submit-and-deliver; the print document never sees it.
   */
  public set submitting(value: boolean) {
    const next = value === true;
    if (next === this.submittingValue) {
      return;
    }
    this.submittingValue = next;
    this.liveForm?.setBusy("submitting", next);
  }

  public get submitting(): boolean {
    return this.submittingValue;
  }

  /**
   * The ends of the form the submitting line goes at, as a notice's `placement` lists them:
   * the top (the default), the bottom beside the button, or both with the bottom copy a
   * visual echo. Draws again.
   */
  public set submittingPlacement(value: FormNoticePlacement[] | undefined) {
    this.submittingPlacementValue = value;
    this.liveForm?.redraw();
  }

  public get submittingPlacement(): FormNoticePlacement[] | undefined {
    return this.submittingPlacementValue;
  }

  /**
   * The ends of the form the error summary goes at: `["top"]` (the default), `["bottom"]`,
   * both, or `[]` for none — a page with its own summary, or a design that shows the inline
   * messages alone. Draws again.
   */
  public set errorSummaryPlacement(value: FormNoticePlacement[] | undefined) {
    this.errorSummaryPlacementValue = value;
    this.liveForm?.redraw();
  }

  public get errorSummaryPlacement(): FormNoticePlacement[] | undefined {
    return this.errorSummaryPlacementValue;
  }

  // ── The builder canvas's settings ──────────────────────────────────────────────────────────

  /**
   * How a data grid (or any collection-bound container) draws its rows:
   * `"entries"` (the default) one row per entry, with its buttons; `"template"` its header and
   * one row of its children at their own ids, which the builder's canvas sets while editing.
   * Draws again: the render output carries both.
   */
  public set dataGridRows(value: "entries" | "template" | undefined) {
    if (value === this.dataGridRowsValue) {
      return;
    }
    this.dataGridRowsValue = value;
    this.liveForm?.redraw();
  }

  public get dataGridRows(): "entries" | "template" | undefined {
    return this.dataGridRowsValue;
  }

  /**
   * Draws components a rule is hiding rather than leaving them out (`visible: false` on their
   * models, for the canvas hooks to mark). A build-mode affordance; a live form leaves it off,
   * because a hidden field is hidden. Draws again.
   */
  public set showHiddenComponents(value: boolean) {
    const next = value === true;
    if (next === this.showHiddenValue) {
      return;
    }
    this.showHiddenValue = next;
    this.liveForm?.redraw();
  }

  public get showHiddenComponents(): boolean {
    return this.showHiddenValue;
  }

  /**
   * CSS added after the binding's and the design system's rules, inside this element's shadow
   * root, as one adopted sheet. The builder canvas passes its chrome styles here so they reach
   * the decorated markup while staying on the builder's side of the CSS isolation boundary.
   */
  public set extraStyles(value: string) {
    this.extraStylesValue = typeof value === "string" ? value : "";
    this.applyExtraStyles();
  }

  public get extraStyles(): string {
    return this.extraStylesValue;
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Host-configured chrome drawn with the form — a language switcher, a logo, instructions in
   * its header or footer (see `FormChromeConfiguration`). The host's parts are drawn after
   * whatever the form's author composed in `root.configuration.chrome`; unset (the
   * default) adds none, and the form's own still draws. A part's look is the binding's chrome
   * adapter for its type, else Datum's. Draws again.
   */
  public set chrome(value: FormChromeConfiguration | undefined) {
    this.chromeValue = value;
    this.noteLeftOut();
    this.liveForm?.redraw();
  }

  public get chrome(): FormChromeConfiguration | undefined {
    return this.chromeValue;
  }

  /**
   * The heading level of the form's title in the page's outline (1 unless said); the receipt's
   * title sits one under it. Draws again.
   */
  public set headingLevel(value: number | undefined) {
    this.headingLevelValue = value;
    this.liveForm?.redraw();
  }

  public get headingLevel(): number | undefined {
    return this.headingLevelValue;
  }

  // ── Data sources, journeys, files ──────────────────────────────────────────────────────────

  /**
   * Data sources the host defined when wiring this form (`defineDataSources`): the options a
   * `select`, `radio` or `checkboxes` naming one of their ids in `data.sourceId` offers. Asked
   * before the runtime's own registered sources, so a host can wire a page's lists here and
   * leave the shared ones registered. Builds the form again: options are part of the render
   * output.
   */
  public set dataSources(value: DataSourceSet | undefined) {
    this.dataSourcesValue = value;
    this.timedSources = undefined;
    this.noteLeftOut();
    this.liveForm?.request();
  }

  public get dataSources(): DataSourceSet | undefined {
    return this.dataSourcesValue;
  }

  /**
   * What draws a journey page: which components it shows, its errors, meta and own
   * module (Back, the heading, Continue or Submit). The host (the `datum-form` element, once the
   * journeys chunk has loaded) hands the kit it loaded; unset, the render layer's default kit
   * (the Noop one unless the host called `setDefaultJourneyRenderKit`). A `NoopJourneyRenderKit`
   * draws every form as the one page it is. Mounts the form again.
   */
  public set journeyKit(value: JourneyRenderKit | undefined) {
    if (value === this.journeyKitValue) {
      return;
    }
    this.journeyKitValue = value;
    this.scheduleMount();
  }

  public get journeyKit(): JourneyRenderKit | undefined {
    return this.journeyKitValue;
  }

  /**
   * Whether the first draw waits for the data sources: `"none"` (the default) draws the form
   * at once, a field whose choices are still coming drawn as loading and drawn again when its
   * source answers or times out; `"all"` draws nothing until every source has answered or timed
   * out. Later edits are always drawn at once.
   */
  public set dataSourceWait(value: "none" | "all" | undefined) {
    this.dataSourceWaitValue = value === "all" ? "all" : "none";
  }

  public get dataSourceWait(): "none" | "all" {
    return this.dataSourceWaitValue;
  }

  /**
   * How long a data source the host defined (`dataSources`) may take before it counts as
   * failed, in milliseconds; `0` for no limit, unset for 15000. A failed source is drawn under
   * its field and reported as `datum-error`. The runtime's own registered sources have the
   * same limit through `FormRuntime`'s `dataSourceTimeoutMs`.
   */
  public set dataSourceTimeout(value: number | undefined) {
    const next = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_DATA_SOURCE_TIMEOUT_MS;
    if (next === this.dataSourceTimeoutValue) {
      return;
    }
    this.dataSourceTimeoutValue = next;
    this.timedSources = undefined;
    this.liveForm?.request();
  }

  public get dataSourceTimeout(): number {
    return this.dataSourceTimeoutValue;
  }

  /**
   * The storages a `file` component may name in `configuration.storage`, by kind. Unset,
   * the engine's base64 storage is the only one; a host adds its own (a bucket, an upload
   * endpoint) with `createFileStorageResolver([...])`. Read at each pick: nothing is drawn again.
   */
  public set fileStorage(value: FileStorageResolver | undefined) {
    this.fileStorageValue = value;
  }

  public get fileStorage(): FileStorageResolver | undefined {
    return this.fileStorageValue;
  }

  // ── PDF ────────────────────────────────────────────────────────────────────────────────────

  /**
   * What turns the form into PDF bytes: `@argusvane/datum-pdf-kernel`'s in-process program,
   * the same program in a QuickJS runtime, or a host's own. Unset, {@link renderPdf} answers
   * nothing and a host shows no PDF control. Nothing is drawn again: the provider is consulted
   * when a PDF is asked for, not when the form is drawn.
   */
  public set pdfProvider(value: PdfRenderProvider | undefined) {
    this.pdfProviderValue = value;
    this.noteLeftOut();
  }

  public get pdfProvider(): PdfRenderProvider | undefined {
    return this.pdfProviderValue;
  }

  /** Where the PDF's fonts come from. Unset, the kernel falls back to the standard 14 with warnings. */
  public set pdfFonts(value: PdfFontProvider | undefined) {
    this.pdfFontsValue = value;
  }

  public get pdfFonts(): PdfFontProvider | undefined {
    return this.pdfFontsValue;
  }

  /** Resolves a template layout's PDF by storage kind. Unset, inline base64 templates still work. */
  public set pdfTemplates(value: PdfTemplateResolver | undefined) {
    this.pdfTemplatesValue = value;
  }

  public get pdfTemplates(): PdfTemplateResolver | undefined {
    return this.pdfTemplatesValue;
  }

  /** Resolves images a layout names by URL. Unset, such images are left out with a warning. */
  public set pdfImages(value: PdfImageResolver | undefined) {
    this.pdfImagesValue = value;
  }

  public get pdfImages(): PdfImageResolver | undefined {
    return this.pdfImagesValue;
  }

  /**
   * The PDF theme a PDF renders under, for a layout that names none. Unset, the PDF theme the
   * binding suggests ({@link LiveBinding.pdfTheme}), else the engine's default PDF theme.
   */
  public set pdfTheme(value: PdfThemeDefinition | undefined) {
    this.pdfThemeValue = value;
  }

  public get pdfTheme(): PdfThemeDefinition | undefined {
    return this.pdfThemeValue;
  }

  /**
   * The PDF theme the drawing binding suggests (`LiveBinding.pdfTheme`), for the ladder's binding
   * rung; nothing when the binding suggests none (a form then prints under `datum-pdf`).
   */
  private pdfBindingSuggestion(): { binding: PdfBindingSuggestion } | Record<string, never> {
    const binding = this.drawingBinding();
    return binding.pdfTheme === undefined ? {} : { binding: { id: binding.id, pdfTheme: binding.pdfTheme } };
  }

  /**
   * Where a PDF theme named by id — a layout's `theme`, a `renderPdf({ themeId })` — is looked
   * up: the host's theme registry, or a lookup function. Unset, every id is unknown and the
   * document warns `theme.notFound` and renders under `pdfTheme`.
   */
  public set pdfThemes(value: PdfThemeSource | undefined) {
    this.pdfThemesValue = value;
  }

  public get pdfThemes(): PdfThemeSource | undefined {
    return this.pdfThemesValue;
  }

  /**
   * What a PDF does with a bound component whose type offers no rendition: `ignore`,
   * `warn` (the default) or `fail`. The default for `renderPdf` and `downloadPdf` — the
   * toolbar's PDF button among them — when the call names no policy of its own.
   */
  public set pdfUnknownComponents(value: PdfUnknownComponentPolicy | undefined) {
    this.pdfUnknownComponentsValue = value;
  }

  public get pdfUnknownComponents(): PdfUnknownComponentPolicy | undefined {
    return this.pdfUnknownComponentsValue;
  }

  /**
   * What to do with a rule the parser rejects (formulas): `fail` (the default) or `warn`, over the form's own
   * `configuration.formulaErrors`. The default for `renderPdf` and `downloadPdf` when the call
   * names no policy of its own; the host that builds the runtime hands the same word to its
   * `formulaErrors` dependency.
   */
  public set formulaErrors(value: FormulaErrorPolicy | undefined) {
    this.formulaErrorsValue = value;
  }

  public get formulaErrors(): FormulaErrorPolicy | undefined {
    return this.formulaErrorsValue;
  }

  /**
   * `"refuse"` (the default) or `"allow"`: whether a layout formula's `matches` pattern of a
   * catastrophic shape compiles. The default for `renderPdf` and `downloadPdf`
   * when the call names none, forwarded the way {@link formulaErrors} is.
   */
  public set riskyPatterns(value: "refuse" | "allow" | undefined) {
    this.riskyPatternsValue = value;
  }

  public get riskyPatterns(): "refuse" | "allow" | undefined {
    return this.riskyPatternsValue;
  }

  /**
   * Who signs the PDFs this element renders: a `PdfSigner` over the
   * host's key, a cloud KMS, or the person's own hardware token through a local agent
   * (`createAgentPdfSigner`). Set, every `renderPdf` and `downloadPdf` that names no
   * `signature` of its own — the toolbar's PDF button among them — is signed, never silently
   * unsigned: a provider that cannot complete a signature rejects. Unset, PDFs are plain.
   */
  public set pdfSigner(value: PdfSigner | undefined) {
    this.pdfSignerValue = value;
    this.noteLeftOut();
  }

  public get pdfSigner(): PdfSigner | undefined {
    return this.pdfSignerValue;
  }

  /** The settings and timestamper that go with {@link pdfSigner}; nothing without one. */
  public set pdfSignature(value: PdfSignatureOptions | undefined) {
    this.pdfSignatureValue = value;
  }

  public get pdfSignature(): PdfSignatureOptions | undefined {
    return this.pdfSignatureValue;
  }

  /**
   * The PDF layouts the form declares, named for its current locale — what a host lists in a
   * picker. Empty when it declares none: a PDF is still available then, from the layout the
   * engine derives, so a host with one button needs no picker.
   */
  public pdfLayouts(): PdfLayoutOption[] {
    const runtime = this.runtimeRef;
    if (!runtime || !this.allows("pdf")) {
      return [];
    }
    const locale = runtime.state().locale;
    const sources = { translations: runtime.translations?.(), catalog: runtime.translationCatalog?.() };
    const definition = { pdf: runtime.pdfConfiguration?.() };
    // Blind to conditions on purpose: the default is what prints when none holds.
    const defaultId = findPdfLayout(definition)?.id;
    return readPdfConfiguration(definition).map((layout) => ({
      id: layout.id,
      // A layout's name is a string in the form's default language, translated at `pdf › <layout id> › name`.
      label: typeof layout.name === "string" ? resolveText(layout.name, addressOf.pdf(layout.id, ["name"]), locale, sources) : layout.id,
      kind: layout.kind,
      isDefault: layout.id === defaultId,
      conditional: readPdfLayoutCondition(layout) !== undefined
    }));
  }

  /**
   * Renders the form as a PDF through {@link pdfProvider} (see `renderFormPdf`): the layout
   * asked for by id, else the first whose `when` holds on the answers as they would be
   * submitted, else the form's default, else one derived from its tree. Resolves to
   * nothing when there is no runtime or no provider.
   */
  public async renderPdf(options: RenderFormPdfOptions = {}): Promise<RenderFormPdfResult | undefined> {
    if (!this.allows("pdf")) {
      // Before anything is asked of the PDF pipeline: its chunk is never requested.
      throw this.leftOut("pdf", "renderPdf()");
    }
    const runtime = this.runtimeRef;
    const provider = this.pdfProviderValue;
    if (!runtime || !provider) {
      return undefined;
    }
    const { renderFormPdf } = await loadPdfPipeline();
    let effective = options;
    if (options.unknownComponents === undefined && this.pdfUnknownComponentsValue !== undefined) {
      effective = { ...effective, unknownComponents: this.pdfUnknownComponentsValue };
    }
    if (options.formulaErrors === undefined && this.formulaErrorsValue !== undefined) {
      effective = { ...effective, formulaErrors: this.formulaErrorsValue };
    }
    if (options.riskyPatterns === undefined && this.riskyPatternsValue !== undefined) {
      effective = { ...effective, riskyPatterns: this.riskyPatternsValue };
    }
    if (options.signature === undefined && this.pdfSignerValue !== undefined) {
      effective = { ...effective, signature: { signer: this.pdfSignerValue, ...this.pdfSignatureValue } };
    }
    return renderFormPdf(
      runtime,
      {
        provider,
        fonts: this.pdfFontsValue,
        templates: this.pdfTemplatesValue,
        images: this.pdfImagesValue,
        theme: this.pdfThemeValue,
        themes: this.pdfThemesValue,
        ...this.pdfBindingSuggestion()
      },
      effective
    );
  }

  /**
   * {@link renderPdf}, then the bytes to the person as a download — after a cancelable
   * `datum-pdf` event a host may take over (see `downloadPdf`). Resolves to nothing when
   * nothing was rendered. `trigger` and `agent` go on that event's detail
   * only: they are taken off before the render options are handed on. The file is staged in
   * the element's own document: the `downloadPdf()` function's `document` option is not one of
   * this method's.
   */
  public async downloadPdf(options: Omit<DownloadPdfOptions, "document"> = {}): Promise<DownloadPdfResult | undefined> {
    if (!this.allows("pdf")) {
      throw this.leftOut("pdf", "downloadPdf()");
    }
    const { trigger, agent, ...render } = options;
    const result = await this.renderPdf(render);
    if (!result) {
      return undefined;
    }
    return downloadPdf(
      this,
      {
        bytes: result.bytes,
        fileName: result.fileName,
        layoutId: result.layoutId,
        layoutChoice: result.layoutChoice,
        pageCount: result.pageCount,
        warnings: result.warnings,
        ...(result.signature ? { signature: result.signature } : {})
      },
      {
        document: this.ownerDocument,
        ...(trigger !== undefined ? { trigger } : {}),
        ...(agent !== undefined ? { agent } : {})
      }
    );
  }

  // ── What hosts and the agent layer call ────────────────────────────────────────────────────

  /**
   * Settles once every change made so far is drawn and its new fields are ready: a
   * caller that wrote values and wants to reveal, highlight or read the drawn form back waits here.
   * A mount asked for in this task is made first. Resolved at once when nothing is mounted.
   */
  public async painted(): Promise<void> {
    for (let rounds = 0; rounds < 10; rounds += 1) {
      await this.mounting;
      const live = this.liveForm;
      if (!live) {
        return;
      }
      await live.ready.catch(() => undefined);
      await live.updated();
      if (this.liveForm === live && !this.mountQueued) {
        return;
      }
    }
  }

  /**
   * Commits every answer still being typed: what the person is typing becomes settled
   * now, as if each field had been left. Called before the body goes inert for an agent session,
   * so a half-typed answer is reported before the assistant's writes. Nothing when
   * no answer is interim.
   */
  public settleInput(): void {
    this.liveForm?.settleInput();
  }

  /**
   * Runs validation and moves focus to the first error, the same as submitting the inner form.
   * Public so a wrapper that draws its own Validate control (see `<datum-form-host>`) drives
   * validation *through* the renderer and keeps that focus behaviour, rather than calling
   * `runtime.validate()` behind its back. `focus: false` shows the errors without moving focus
   * (or scrolling): a page validating a form it is only showing, as a review page does at load.
   */
  public async validate(options: { focus?: boolean } = {}): Promise<void> {
    const runtime = this.runtimeRef;
    if (!runtime) {
      return;
    }
    await runtime.validate();
    if (options.focus !== false) {
      await this.focusErrorsWhenDrawn();
    }
  }

  /**
   * Moves focus to the first blocking error once the draw the errors brought has landed: the
   * error summary or the first field in error, as the binding says (`errorFocus`, the summary for
   * Datum's), opening the step or tab that hides it. Public so a wrapper that puts errors into
   * the runtime itself (a server's verdict after delivery, through `FormRuntime.setErrors`) gets
   * the same focus behaviour as validating through this element.
   */
  public focusFirstError(): void {
    void this.focusErrorsWhenDrawn();
  }

  private async focusErrorsWhenDrawn(): Promise<void> {
    await this.painted();
    this.liveForm?.focusErrors();
  }

  /**
   * Moves focus to the {@link notice} once the draw that shows it has landed, the way
   * {@link focusFirstError} moves to the summary: a receipt the person is not taken to is a
   * receipt they may never notice. Nothing to do without one.
   */
  public focusNotice(): void {
    void this.painted().then(() => {
      this.notices?.focusNotice();
    });
  }

  /**
   * Opens whatever hides a component — the tabs and steps around it, a step's own steps
   * container on that step — once the draw in flight (if any) has landed, so the component can
   * be seen, moving no focus. The builder canvas calls this for the component the author just
   * selected or dropped, and an agent for what it is about to show: both act while someone else
   * holds focus (the inspector's box, the person's own typing), so a reveal that took it would
   * pull it out from under them. To take the person to a field, ask for focus: `focusFirstError`
   * for the first blocking error, or `live.focusField(key)`, which reveals and focuses. A
   * component the drawn form does not hold is nothing to open.
   */
  public revealComponent(componentId: string): void {
    void this.painted().then(() => {
      this.liveForm?.reveal(componentId);
    });
  }

  // ── Print ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The print theme `print()` draws with: `basicPrintTheme` when left out (Datum's
   * `datumPrintTheme` is the other one the engine ships). A theme draws static markup from the
   * print model and never runs the design system's JavaScript; the host's `assets` stylesheets and
   * fonts are linked into the print document for a theme other than Datum's two, never its scripts.
   * Read when `print()` is called.
   */
  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  /**
   * The renditions the form offers a person (`configuration.print.renditions`, `["answers"]` when
   * it says nothing) and its default, for a page or toolbar that offers a choice. Read from the
   * runtime's form as it stands; with no runtime, the defaults.
   */
  public get printRenditions(): PrintRenditionsOffered {
    let configuration: unknown;
    try {
      configuration = this.runtimeRef?.formRoot()?.configuration;
    } catch {
      configuration = undefined;
    }
    const print = readPrintConfiguration(configuration);
    return { offered: [...print.renditions], default: print.defaultRendition };
  }

  /**
   * Prints the form through the browser's print dialog.
   *
   * What prints is the print model (`render/print/`): the read-only render output folded as the
   * live form is (every tab, step and journey page on the person's path as a headed section, in
   * order; grids as table rows), every answer worded (choice labels, dates in the locale's words,
   * "Not answered"), drawn by {@link printTheme} into a complete document that runs no script, and
   * presented through a hidden same-origin frame so only the form reaches the paper, whatever
   * chrome the host has around it. Errors do not print. A read-only form prints what it shows; a
   * live one follows each component's `print.show`. `rendition: "blank"` prints a paper
   * form to fill in by hand instead, and `rendition: "filled"` that paper form with the answers
   * written in; without one, the form's default rendition prints. A running header and footer, a
   * first-page heading and the print scale follow the form's own `configuration.print`; the margin
   * boxes are Chromium's (Firefox and Safari ignore them). `locale` prints in another language
   * than the form shows, leaving the form's own as it is.
   *
   * Before the dialog, a cancelable `datum-print` event carries the document
   * ({@link DatumPrintDetail}); `preventDefault()` hands it to the host and nothing prints.
   *
   * Resolves once the frame's `print()` has been called (Chrome and Firefox return when the
   * dialog closes, Safari immediately), or at once when there is no runtime, when a newer
   * `print()` superseded this one or the element left the page (checked again right before the
   * dialog, after the wait for the document's sheets), or when the event was cancelled. The frame stays in
   * `document.body` until its `afterprint`, the next print, or this element leaving the page.
   */
  public async print(options: PrintCallOptions = {}): Promise<void> {
    if (!this.allows("print")) {
      throw this.leftOut("print", "print()");
    }
    const runtime = this.runtimeRef;
    if (!runtime) {
      return;
    }
    const token = ++this.printToken;
    const prepared = await this.buildPrintDocument(runtime, options, () => token === this.printToken);
    if (!prepared) {
      return;
    }
    if (prepared.fellBack) {
      console.warn(`[${DATUM_FORM_RENDERER_TAG}] the print theme cannot print as it should (${prepared.fellBack.join("; ")}); printed with the basic print theme instead.`);
    }
    await this.presentPrint(prepared, token);
  }

  /**
   * The document {@link print} would present for `options`, built and handed back without
   * presenting it: no frame, no `datum-print`, no dialog, no focus moved and no console warning
   * (`fellBack` says why a theme was set aside). For a page that shows the print itself (a
   * preview) or sends it elsewhere. Resolves to `undefined` with no runtime, or when the runtime
   * is replaced while the document is built. A print already in flight is left to finish.
   */
  public async preparePrintDocument(options: PrintCallOptions = {}): Promise<PreparedPrint | undefined> {
    if (!this.allows("print")) {
      throw this.leftOut("print", "preparePrintDocument()");
    }
    const runtime = this.runtimeRef;
    return runtime ? this.buildPrintDocument(runtime, options, () => true) : undefined;
  }

  /**
   * Builds the print document for `runtime` as it stands: the print pipeline loaded, the print
   * source read off the runtime and drawn by the print theme. `current` says whether the caller
   * still wants it (a newer `print()` supersedes an older one); `undefined` when it does not, or
   * when the element's runtime changed meanwhile. Touches nothing of the live form.
   */
  private async buildPrintDocument(runtime: RenderHostRuntime, options: PrintCallOptions, current: () => boolean): Promise<PreparedPrint | undefined> {
    const { readPrintSource, preparePrint, basicPrintTheme } = await loadPrintPipeline();
    if (!current() || this.runtimeRef !== runtime) {
      return undefined;
    }
    const binding = this.drawingBinding();
    const locale = typeof options.locale === "string" && options.locale.trim() !== "" ? options.locale.trim() : undefined;
    const source = await readPrintSource(this.drawnRuntime(runtime), {
      rendition: options.rendition,
      // A read-only or disabled form prints what it shows.
      mode: liveModeOf(this.modeValue) === "interactive" ? "interactive" : "readonly",
      ...(locale !== undefined ? { locale } : {}),
      render: this.printRenderOptions(),
      texts: this.textsValue,
      pack: { texts: binding.texts, messages: binding.messages },
      page: options.page,
      // A receipt prints with the form; a submission in flight does not.
      notice: this.noticeValue
    });
    if (!current() || this.runtimeRef !== runtime) {
      return undefined;
    }
    return preparePrint(source, {
      theme: this.printThemeValue ?? basicPrintTheme,
      assets: this.drawnAssets(),
      base: this.ownerDocument.baseURI
    });
  }

  /** Presents a prepared print through the print frame, after the cancelable `datum-print`: the half of {@link print} a preview never runs. */
  private async presentPrint(prepared: PreparedPrint, token: number): Promise<void> {
    const { presentPrintDocument } = await loadPrintPipeline();
    if (token !== this.printToken) {
      return;
    }
    // A frame whose afterprint never came (Safari, a cancelled dialog) goes now.
    this.printFrame?.remove();
    this.printFrame = undefined;
    const presented = await presentPrintDocument(prepared.html, this.ownerDocument, {
      theme: prepared.theme,
      fellBack: prepared.fellBack,
      selfCheck: prepared.selfCheck,
      fallback: prepared.fallback,
      stillWanted: () => token === this.printToken,
      beforePrint: ({ html, theme, fellBack }) =>
        token === this.printToken &&
        this.dispatchEvent(
          new CustomEvent<DatumPrintDetail>("datum-print", {
            detail: { html, theme: theme ?? prepared.theme, ...(fellBack ? { fellBack } : {}) },
            bubbles: true,
            composed: true,
            cancelable: true
          })
        )
    });
    const frame = presented.frame;
    if (!frame) {
      return;
    }
    if (token !== this.printToken) {
      frame.remove();
      return;
    }
    // Chrome fires afterprint inside print() itself, so the frame has usually removed
    // itself by now; only one still attached is worth remembering.
    this.printFrame = frame.isConnected ? frame : undefined;
  }

  /** What the print build takes from the element: the host's data sources, the journey kit, the wording. */
  private printRenderOptions(): RuntimeRenderOptions {
    const dataSources = this.drawnDataSources();
    return {
      ...(dataSources ? { dataSources } : {}),
      journeyKit: this.drawnJourneyKit(),
      wording: {
        messages: this.messagesValue,
        texts: this.textsValue
      }
    };
  }
}

export function defineDatumFormRendererElement(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_FORM_RENDERER_TAG)) {
    customElements.define(DATUM_FORM_RENDERER_TAG, DatumFormRendererElement);
  }
}
