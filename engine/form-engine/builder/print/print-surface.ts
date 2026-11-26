/**
 * The Print workspace's surface (`<datum-builder-print>`): the form's print
 * settings in a card beside one continuous sheet, the real print document at the paper's width.
 * Loaded in a chunk of its own the first time the author opens Print (`print-loader.ts`).
 *
 * - The card (`print-settings-model.ts`) edits the form root's `configuration.print` through the
 *   form's controller: the versions offered and the default, the title on the first page, the
 *   scale, the four header and footer slots with their insert shortcuts, and the list of the
 *   components that set how they print, each with Clear. A click on the sheet, or a choice in the
 *   card's Component picker (the keyboard's way to any component), selects the component on the
 *   controller and the card shows its "On paper" fields, the inspector's own rows
 *   (`inspectorSectionRowsHtml`), written through the controller.
 * - The card is painted only when its structure changes (the paint contract of the builder's
 *   panels): a value typed into a slot box, the scale box or a note is written as it is typed,
 *   after a pause, and the box keeps its focus and caret; the other boxes take the new values in
 *   place.
 * - The sheet (`print-preview.ts`) is drawn by a `<datum-form-renderer>` of the surface's own, set
 *   up by the shell as the canvas's is, from a runtime made for the sample answers: none, the
 *   answers last typed in Try it, a test scenario's replayed to its end, or a pasted submission;
 *   with a sample receipt as the notice's data. The boxes for the pasted submission and the receipt
 *   open in the Preview card beside the settings, under its tools: the submission's shows only
 *   while the picker is on a pasted submission, the receipt's behind the card's Sample receipt
 *   button. Those choices are this session's, never the
 *   form's: nothing of them is written into the definition or the history. A form that opens as a
 *   journey is drawn from a journey session of Print's own (`BuilderMode.printSession`), never Try
 *   it's. The sheet is drawn again a moment after each edit, never emptied in between; while the
 *   shell hides the surface (`shown`), nothing is drawn and the session is let go, and the sheet is
 *   measured again and drawn once when it is back. A value typed for a document the controller no
 *   longer holds (another loaded, a step undone) is dropped, never written into what is there now.
 * - "Print a test page" prints through the renderer's own `print()`, so the host hears
 *   `datum-print` as it would from the live form (the surface sends the event on from itself).
 */
import type { BuilderChangeEvent, BuilderController } from "../controller/builder-controller.js";
import type { BuilderTextCatalog, BuilderTextKey } from "../logic/builder-texts.js";
import type { BuilderPrintSession } from "../web-component/builder-modes.js";
import type { FormulaFunctionsSource } from "../web-component/builder-panels.js";
import type { FormDefinition, ComponentNode } from "../../core/schema/types.js";
import type { PrintTheme } from "../../render/print/theme.js";
import type { PreparedPrint } from "../../render/print/document.js";
import type { TestsEntryModel, TestsRunner } from "../form-tests/tests-model.js";
import { areaWords } from "./print-texts-en.js";
import { printStyles } from "./print-styles.js";
import { builderTokens, esc, inspectorSectionRowsHtml } from "../web-component/builder-shared.js";
import { rovingToolbar } from "../web-component/toolbar-roving.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement,
  type DatumPrintDetail,
  type RenderHostRuntime
} from "../../render/web-component/form-renderer-element.js";
import { BuilderPreviewRuntime } from "../preview/builder-preview-runtime.js";
import { formulaSignatures } from "../formula/feel-functions.js";
import { kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import { PRINT_RENDITIONS, type PrintRendition } from "../../core/schema/print.js";
import { declaredDefaultLocale, localeDisplayName, supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import { defaultFormText } from "../../core/localization/form-texts.js";
import { loadTestsPanel } from "../web-component/tests-panel-loader.js";
import {
  PRINT_SLOTS,
  clearComponentPrintEdits,
  componentLabel,
  componentPrintEntries,
  printPickerEntries,
  defaultRenditionEdits,
  insertAt,
  insertionText,
  journeyPageBreaksEdits,
  labelSourcesOf,
  printFieldOptions,
  printSettingsView,
  renditionToggleEdits,
  scaleEdits,
  settledPrintEdits,
  slotEdits,
  slotResetEdits,
  titleOnFirstPageEdits,
  type PrintEdit,
  type PrintRegion,
  type PrintSettingsView,
  type PrintSlotInsert,
  type PrintSlotName
} from "./print-settings-model.js";
import { readPastedAnswers, readReceiptData, readSampleSourceValue, sampleSourceValue, type PastedReading, type PrintSampleSource } from "./print-samples.js";
import { PRINT_PAPERS, PrintPreview, measurePrintDocument, type PrintMeasurer, type PrintPaper, type PrintShown } from "./print-preview.js";

/** The zoom's minus and plus, the strokes the canvas bar draws its own with. */
const zoomIcon = (path: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;

export const DATUM_BUILDER_PRINT_TAG = "datum-builder-print";

/** What the shell lends the surface beside the form's controller. */
export interface PrintWorkspaceSources {
  /** The answers last typed in Try it (the canvas's preview store), as the store holds them. */
  tryAnswers?(): Record<string, unknown> | undefined;
  /**
   * A journey's own runtime for the answers (kernel JSON), when the form opens as a journey: its
   * pages print as the person's path has them. A print's own session, never Try it's; the surface
   * waits for it to be ready and disposes it when it draws from another, when it is hidden and
   * when it leaves the page. `undefined`: the form prints whole.
   */
  journeySession?(answers: Record<string, unknown>): BuilderPrintSession | undefined;
  /** Whether the form has a journey (the "Each journey page starts a new sheet" box is offered). */
  hasJourney?(): boolean;
  /** Sets the renderer up as the canvas's is: the binding, its files, the texts, the journey kit. */
  configureRenderer?(renderer: DatumFormRendererElement): void;
}

/** The zoom steps of − and +. */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5];

/** How long a pause in typing is before the value is written. */
const WRITE_PAUSE_MS = 400;

/** How long after an edit the sheet is drawn again. */
const REFRESH_PAUSE_MS = 250;

/** The runtime the sheet is drawn from, and what lets it go. `session`: a mode's own (a journey's), which knows no data sources of the builder's. */
interface SampleRuntime {
  runtime: RenderHostRuntime;
  session: boolean;
  dispose?(): void;
}

/** A captured focus: which control, its value and its selection, to put back after a paint. */
interface FocusMark {
  selector: string;
  value: string | undefined;
  start: number | null;
  end: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `value` made safe inside a double-quoted attribute selector. */
const cssString = (value: string): string => value.replace(/["\\]/g, "\\$&");

/** The node with `id` under `root`. */
function findNode(root: ComponentNode, id: string): ComponentNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of Array.isArray(group) ? group : []) {
      const hit = findNode(child, id);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** Whether the form holds anything to print beside its root. */
function hasContent(root: ComponentNode): boolean {
  return Object.values(root.children ?? {}).some((group) => Array.isArray(group) && group.length > 0);
}

export class DatumBuilderPrintElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private ctrl: BuilderController | undefined;
  private unsubscribe: (() => void) | undefined;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private functionsSource: FormulaFunctionsSource | undefined;
  private testsEnabledValue = true;
  private printThemeValue: PrintTheme | undefined;
  private sourcesValue: PrintWorkspaceSources = {};
  private measurer: PrintMeasurer = measurePrintDocument;
  private readonly words = areaWords();

  // --- session state: never the form's ---------------------------------------------------
  /** The version previewed; `undefined` is the form's default. */
  private version: PrintRendition | undefined;
  private sample: PrintSampleSource = { kind: "none" };
  private pastedText = "";
  private receiptText = "";
  private localeChoice: string | undefined;
  private paper: PrintPaper = "letter";
  private zoomChoice: number | "fit" = "fit";
  /** The component whose "On paper" card is up. */
  private selectedId: string | undefined;
  /** Whether the Sample receipt box is shown; its text is kept while it is not. */
  private receiptOpen = false;
  /** The test scenarios, parsed once per tests block; their replayed answers, once per scenario. */
  private scenarios: { key: string; entries: TestsEntryModel[]; runner: TestsRunner } | undefined;
  private scenariosLoading = false;
  private readonly scenarioValues = new Map<string, Record<string, unknown>>();

  // --- drawing state ------------------------------------------------------------------------
  private preview: PrintPreview | undefined;
  private rendererEl: DatumFormRendererElement | undefined;
  private current: SampleRuntime | undefined;
  private lastPrepared: PreparedPrint | undefined;
  private settingsKey: string | undefined;
  private toolbarKey: string | undefined;
  /** Puts the toolbar's one Tab stop right at once, after its tools are drawn again. */
  private syncToolbarStop: (() => void) | undefined;
  private readonly writeTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshToken = 0;
  private inFlight: Promise<void> | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private problem: string | undefined;
  /** Whether the shell shows the surface (the Print workspace is on); hidden, nothing is drawn. */
  private shownValue = true;
  /** Something changed while the surface was hidden or off the page: the sheet is drawn again when it is back. */
  private dirty = false;
  /** The "?" notes open on the component card, by property path: kept across the card's paints. */
  private readonly openHelp = new Set<string>();
  /** A typed value was dropped unwritten: the next paint gives every box the form's value, the focused one too. */
  private staleTyping = false;
  /** The slot whose Insert menu is open. */
  private insertOpen: string | undefined;
  /** Bumped whenever the scenarios' replays are let go: a replay that started before is used for its own draw, never kept. */
  private replayGeneration = 0;

  /**
   * Where the surface's Undo and Redo keys go: the shell's one method, which asks the mode's
   * history first, as for the builder's panels. No paint. Unset (the surface used on its own):
   * the controller's own Undo and Redo.
   */
  public historyStep: ((controller: BuilderController, direction: "undo" | "redo") => void) | undefined;

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    this.root.addEventListener("change", (event) => this.onChangeEvent(event));
    // Undo and Redo are the form's, from anywhere in the surface but the two sample boxes; a typed value waiting is written first.
    this.root.addEventListener("keydown", (event) => this.onKeydown(event as KeyboardEvent), true);
  }

  public connectedCallback(): void {
    this.subscribe();
    this.paint();
    this.scheduleRefresh(0);
    if (typeof ResizeObserver !== "undefined" && !this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.zoomChoice === "fit" && this.shownValue) {
          this.applyZoom();
        }
      });
      const scroller = this.root.querySelector<HTMLElement>("[data-print-scroller]");
      if (scroller) {
        this.resizeObserver.observe(scroller);
      }
    }
  }

  /** Off the page (the shell's markup redrawn, the builder removed): every runtime, timer and observer goes; a return makes them again. */
  public disconnectedCallback(): void {
    this.flushWrites();
    this.closeInsertMenu();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.stopDrawing();
    const renderer = this.rendererEl;
    this.rendererEl = undefined;
    if (renderer) {
      renderer.runtime = undefined;
    }
  }

  /** No draw due or in flight, and the runtime drawn from let go: what is drawn next is drawn afresh. */
  private stopDrawing(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    // A draw in flight lands nowhere.
    this.refreshToken += 1;
    this.inFlight = undefined;
    const current = this.current;
    this.current = undefined;
    current?.dispose?.();
    this.dirty = true;
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.ctrl?.on("change", (detail) => this.onControllerChange(detail as BuilderChangeEvent | undefined));
  }

  /**
   * Whether the shell shows the surface. Hidden (another workspace on), a typed value waiting is
   * written, the journey drawn from is let go, and edits are only noted; shown again, the sheet is
   * measured again (its layout came back) and drawn once if anything changed meanwhile.
   */
  public get shown(): boolean {
    return this.shownValue;
  }

  public set shown(value: boolean) {
    const next = value !== false;
    if (next === this.shownValue) {
      return;
    }
    this.shownValue = next;
    if (!next) {
      this.flushWrites();
      this.stopDrawing();
      return;
    }
    if (!this.isConnected) {
      return;
    }
    this.repaintAll();
    this.preview?.remeasure();
    this.paintPages();
    this.applyZoom();
    if (this.dirty) {
      this.scheduleRefresh(0);
    }
  }

  // --- what the shell sets ------------------------------------------------------------------

  /** The form's controller: Print reads and writes the form only. */
  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  public set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.flushWrites();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctrl = value;
    this.selectedId = undefined;
    this.scenarios = undefined;
    this.forgetReplays();
    if (this.isConnected) {
      this.subscribe();
    }
    this.paint();
    this.scheduleRefresh(0);
  }

  /** The whole definition (journeys, layouts, localization) a scenario is replayed against. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
  }

  public get definition(): (() => FormDefinition | undefined) | undefined {
    return this.definitionSource;
  }

  /** The host's plugin functions, so a rule calling one works on the sheet as on the canvas. */
  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    this.functionsSource = value;
  }

  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.functionsSource;
  }

  /** Whether the Tests feature is on: without it no scenario is offered as a sample. */
  public set testsEnabled(value: boolean) {
    const next = value !== false;
    if (next !== this.testsEnabledValue) {
      this.testsEnabledValue = next;
      if (!next && this.sample.kind === "scenario") {
        this.sample = { kind: "none" };
        this.scheduleRefresh(0);
      }
      this.paintToolbar();
    }
  }

  public get testsEnabled(): boolean {
    return this.testsEnabledValue;
  }

  /** The print theme the sheet and the test page are drawn with (the page's own, as the form element takes it). */
  public set printTheme(value: PrintTheme | undefined) {
    if (value !== this.printThemeValue) {
      this.printThemeValue = value;
      this.paint();
      this.scheduleRefresh(0);
    }
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  /** The shell's seams: Try it's answers, a journey's runtime, the canvas's renderer set-up. */
  public set sources(value: PrintWorkspaceSources | undefined) {
    this.sourcesValue = value ?? {};
    this.paint();
  }

  public get sources(): PrintWorkspaceSources {
    return this.sourcesValue;
  }

  /** How the sheet's document is measured for the page starts; a test environment with no layout sets its own. */
  public set measurePreview(value: PrintMeasurer | undefined) {
    this.measurer = value ?? measurePrintDocument;
    this.preview?.remeasure();
    this.paintPages();
  }

  public get measurePreview(): PrintMeasurer {
    return this.measurer;
  }

  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.repaintAll();
    }
  }

  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.repaintAll();
    }
  }

  /** The renderer the sheet is drawn by (the test page prints through it). */
  public get previewRenderer(): DatumFormRendererElement | undefined {
    return this.rendererEl;
  }

  /** The version the sheet shows: the one chosen, else the form's default. */
  public get rendition(): PrintRendition {
    return this.version ?? this.view().defaultRendition;
  }

  /** The document the sheet shows, as last drawn. */
  public get prepared(): PreparedPrint | undefined {
    return this.lastPrepared;
  }

  /** Resolves once the sheet shows the form as it stands: no write waiting, no draw due or in flight. */
  public async previewSettled(): Promise<void> {
    this.flushWrites();
    for (let round = 0; round < 10; round += 1) {
      if (this.refreshTimer !== undefined) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.inFlight = this.refresh();
      }
      const flight = this.inFlight;
      if (!flight) {
        return;
      }
      await flight;
      if (this.inFlight === flight && this.refreshTimer === undefined) {
        return;
      }
    }
  }

  // --- words ----------------------------------------------------------------------------------

  private t(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return this.words.text(key, params);
  }

  /**
   * The engine's own page number line (form-texts' `printPageNumber`) in the form's default
   * language, worded as the form words it (its `texts` translations, the host's catalog), else the
   * engine's: what the footer's end prints there while the form says nothing, and what the "Page
   * numbers" insert writes (the author's own text from then on, translated in Languages).
   */
  private pageNumberWords(): { pageNumber: string } {
    const controller = this.ctrl;
    const locale = declaredDefaultLocale(controller?.localization()) ?? "en";
    const words = controller ? { translations: controller.translations(), catalog: controller.translationCatalog() } : undefined;
    return { pageNumber: defaultFormText("printPageNumber", locale, words) ?? "" };
  }

  private view(): PrintSettingsView {
    return printSettingsView(this.ctrl?.snapshot().configuration, this.pageNumberWords());
  }

  private say(text: string): void {
    const live = this.root.querySelector<HTMLElement>("[data-print-live]");
    if (live) {
      live.textContent = "";
      live.textContent = text;
    }
  }

  // --- painting -----------------------------------------------------------------------------------

  /** What stays put across paints: the styles, the card, the pane with its sheet, the live region. */
  private frame(): void {
    if (this.root.querySelector("[data-print-main]")) {
      return;
    }
    this.root.innerHTML = `<style>${builderTokens()}${printStyles()}</style>
      <div class="print" data-print-main>
        <div class="side card-stack" data-print-side>
          <div class="settings card-stack" data-print-settings role="group" aria-labelledby="print-title"></div>
          <section class="card group" aria-labelledby="print-preview-title" data-print-preview>
            <h3 class="card-heading" id="print-preview-title" data-print-word="printing.preview.title"></h3>
            <p class="card-lead" data-print-word="printing.preview.lead"></p>
            <div class="preview-tools" data-print-preview-tools></div>
          <div class="samples" data-print-samples hidden>
            <div class="field" data-print-pasted-field hidden><label for="print-pasted" data-print-word="printing.pasted.label"></label>
              <textarea id="print-pasted" data-print-pasted rows="3" spellcheck="false" autocomplete="off" aria-describedby="print-pasted-hint print-pasted-error"></textarea>
              <span class="muted small" id="print-pasted-hint" data-print-word="printing.pasted.hint"></span>
              <span class="problem" id="print-pasted-error" data-print-pasted-error role="alert" hidden></span>
            </div>
            <div class="field" id="print-receipt-field" data-print-receipt-field hidden><label for="print-receipt" data-print-word="printing.receipt.label"></label>
              <textarea id="print-receipt" data-print-receipt rows="3" spellcheck="false" autocomplete="off" data-print-placeholder="printing.receipt.placeholder" aria-describedby="print-receipt-hint print-receipt-error"></textarea>
              <span class="muted small" id="print-receipt-hint" data-print-word="printing.receipt.hint"></span>
              <span class="problem" id="print-receipt-error" data-print-receipt-error role="alert" hidden></span>
            </div>
          </div>
          </section>
        </div>
        <section class="pane" data-print-pane>
          <div class="toolbar" role="toolbar" data-print-toolbar></div>
          <p class="note fallback" data-tone="warning" role="status" data-print-fallback hidden></p>
          <div class="scroller" data-print-scroller tabindex="0" role="group">
            <div class="sheet-box" data-print-zoom-box><div class="sheet" data-print-sheet></div></div>
            <p class="chromium" data-print-chromium data-print-word="printing.slots.chromium"></p>
          </div>
          <div class="empty-state is-page" data-print-empty hidden>
            <h2 data-print-word="printing.empty.title"></h2>
            <p data-print-word="printing.empty.body"></p>
          </div>
        </section>
      </div>
      <p class="sr-only" aria-live="polite" data-print-live></p>`;
    // One Tab stop, arrows between its tools, as every builder toolbar.
    this.syncToolbarStop = rovingToolbar(this.root.querySelector<HTMLElement>("[data-print-toolbar]")!);
    const box = this.root.querySelector<HTMLElement>("[data-print-zoom-box]")!;
    const sheet = this.root.querySelector<HTMLElement>("[data-print-sheet]")!;
    this.preview = new PrintPreview(box, sheet, {
      select: (id) => this.selectFromSheet(id),
      measure: () => this.measurer,
      words: {
        estimated: (page) => this.t("printing.break.estimated", { page }),
        forced: (_page, id, sectionTitle) =>
          sectionTitle === undefined
            ? this.t("printing.break.forced", { label: this.labelOf(id) })
            : sectionTitle === ""
              ? this.t("printing.break.forcedUnnamed")
              : this.t("printing.break.forced", { label: sectionTitle }),
        frameTitle: () => this.t("printing.frame")
      }
    });
    this.settingsKey = undefined;
    this.toolbarKey = undefined;
  }

  private repaintAll(): void {
    this.settingsKey = undefined;
    this.toolbarKey = undefined;
    this.paint();
  }

  private paint(): void {
    if (!this.isConnected) {
      return;
    }
    this.frame();
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-print-word]")) {
      element.textContent = this.t(element.dataset.printWord as BuilderTextKey);
    }
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-print-placeholder]")) {
      element.setAttribute("placeholder", this.t(element.dataset.printPlaceholder as BuilderTextKey));
    }
    this.root.querySelector<HTMLElement>("[data-print-scroller]")?.setAttribute("aria-label", this.t("printing.sheet.label"));
    this.root.querySelector<HTMLElement>("[data-print-toolbar]")?.setAttribute("aria-label", this.t("printing.toolbar"));
    // The sheet's frames are named in the builder's language as it stands.
    this.preview?.retitle();
    this.paintSettings();
    this.paintToolbar();
    this.paintSamples();
    this.paintEmpty();
  }

  private labelOf(id: string | undefined): string {
    const node = id !== undefined && this.ctrl ? findNode(this.ctrl.snapshot(), id) : undefined;
    return node ? componentLabel(node, this.ctrl!.currentLocale(), labelSourcesOf(this.ctrl!)) : (id ?? "");
  }

  /** Records the focused control (its identifying attribute, value and selection) before a paint. */
  private captureFocus(): FocusMark | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    const name = active.getAttributeNames().find((attribute) => attribute.startsWith("data-") && attribute !== "data-control");
    if (!name) {
      return undefined;
    }
    const value = active.getAttribute(name) ?? "";
    const selector = `${active.localName}[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
    const field = active as HTMLInputElement;
    const typed = active instanceof HTMLInputElement && (active.type === "text" || active.type === "number");
    let start: number | null = null;
    let end: number | null = null;
    if (active instanceof HTMLInputElement && active.type === "text") {
      start = active.selectionStart;
      end = active.selectionEnd;
    }
    return { selector, value: typed || active instanceof HTMLTextAreaElement ? field.value : undefined, start, end };
  }

  private restoreFocus(mark: FocusMark | undefined): void {
    if (!mark) {
      return;
    }
    const element = this.root.querySelector<HTMLElement>(mark.selector);
    if (!element) {
      return;
    }
    if (mark.value !== undefined && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      element.value = mark.value;
    }
    element.focus();
    if (element instanceof HTMLInputElement && element.type === "text" && mark.start !== null) {
      element.setSelectionRange(mark.start, mark.end ?? mark.start);
    }
  }

  // --- the settings card ---------------------------------------------------------------------------

  private paintSettings(): void {
    const card = this.root.querySelector<HTMLElement>("[data-print-settings]");
    const controller = this.ctrl;
    if (!card) {
      return;
    }
    if (!controller) {
      card.innerHTML = `<p class="empty">${esc(this.t("shell.noController"))}</p>`;
      this.settingsKey = undefined;
      return;
    }
    if (this.selectedId !== undefined && !findNode(controller.snapshot(), this.selectedId)) {
      this.selectedId = undefined;
      this.openHelp.clear();
    }
    const view = this.view();
    const html = this.selectedId !== undefined ? this.componentCardHtml(this.selectedId) : this.mainCardHtml(view);
    // The structure without the boxes' values: a change of a value alone is taken in place. Only an
    // input's value is left out; an option's value (a field's path, a component's id) is structure.
    const key = html.replace(/(<input\b[^>]*?) value="[^"]*"/g, "$1");
    if (key === this.settingsKey) {
      this.syncValues(card, html);
    } else {
      const focus = this.captureFocus();
      if (focus && this.staleTyping) {
        focus.value = undefined;
      }
      card.innerHTML = html;
      this.settingsKey = key;
      // An open Insert menu is drawn open before focus goes back, or its item refuses focus.
      this.syncInsertMenu();
      this.restoreFocus(focus);
    }
    this.staleTyping = false;
    this.syncLive(card, view);
    this.syncInsertMenu();
  }

  // --- a slot's Insert menu --------------------------------------------------------------------------

  /** The Insert menu's items for `id`'s slot, in order (the arrows walk them). */
  private insertItems(id: string): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>(`[data-print-insert-menu="${cssString(id)}"] [role=menuitem]`)];
  }

  /** The open menu drawn as it stands, across the card's paints (drawn shut, it is opened by script). */
  private syncInsertMenu(): void {
    if (this.insertOpen !== undefined && !this.root.querySelector(`[data-print-insert-menu="${cssString(this.insertOpen)}"]`)) {
      this.closeInsertMenu();
    }
    for (const menu of this.root.querySelectorAll<HTMLElement>("[data-print-insert-menu]")) {
      const open = menu.dataset.printInsertMenu === this.insertOpen;
      menu.hidden = !open;
      this.root.querySelector(`[data-print-insert="${cssString(menu.dataset.printInsertMenu!)}"]`)?.setAttribute("aria-expanded", String(open));
    }
  }

  private openInsertMenu(id: string, focus: "first" | "last"): void {
    if (this.insertOpen !== undefined && this.insertOpen !== id) {
      this.closeInsertMenu();
    }
    this.insertOpen = id;
    this.syncInsertMenu();
    this.ownerDocument.defaultView?.addEventListener("click", this.onInsertOutside);
    const items = this.insertItems(id);
    (focus === "first" ? items[0] : items.at(-1))?.focus();
  }

  /** The menu put away; `focusButton`: focus back on the button that opened it. */
  private closeInsertMenu(focusButton = false): void {
    const id = this.insertOpen;
    if (id === undefined) {
      return;
    }
    this.insertOpen = undefined;
    this.ownerDocument.defaultView?.removeEventListener("click", this.onInsertOutside);
    this.syncInsertMenu();
    if (focusButton) {
      this.root.querySelector<HTMLElement>(`[data-print-insert="${cssString(id)}"]`)?.focus();
    }
  }

  /** A click outside the open menu and its button puts the menu away. */
  private readonly onInsertOutside = (event: Event): void => {
    const wrap = this.insertOpen !== undefined ? this.root.querySelector(`[data-print-insert-wrap="${cssString(this.insertOpen)}"]`) : null;
    if (!wrap || !event.composedPath().includes(wrap)) {
      this.closeInsertMenu();
    }
  };

  /** The menu's keys, as the builder's other action menus: the arrows open it from its button and walk it with Home and End; Escape and Tab put it away. Answers whether the key was the menu's. */
  private onInsertKeydown(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>("[data-print-insert]");
    if (button) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openInsertMenu(button.dataset.printInsert!, event.key === "ArrowDown" ? "first" : "last");
        return true;
      }
      return false;
    }
    const id = this.insertOpen;
    const menu = id !== undefined ? this.root.querySelector<HTMLElement>(`[data-print-insert-menu="${cssString(id)}"]`) : null;
    if (id === undefined || !menu || !target || !menu.contains(target)) {
      return false;
    }
    const items = this.insertItems(id);
    const index = items.indexOf(target);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeInsertMenu(true);
      return true;
    }
    if (event.key === "Tab") {
      this.closeInsertMenu();
      return true;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length > 0) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
      return true;
    }
    return false;
  }

  /** The boxes nobody is typing in take the values of a fresh paint (every box, after a typed value was dropped). */
  private syncValues(card: HTMLElement, html: string): void {
    const template = this.ownerDocument.createElement("template");
    template.innerHTML = html;
    const active = this.staleTyping ? undefined : this.root.activeElement;
    for (const fresh of template.content.querySelectorAll<HTMLInputElement>("input[type=text], input[type=number]")) {
      const name = fresh.getAttributeNames().find((attribute) => attribute.startsWith("data-") && attribute !== "data-control");
      if (!name) {
        continue;
      }
      const selector = `input[${name}="${(fresh.getAttribute(name) ?? "").replace(/["\\]/g, "\\$&")}"]`;
      const live = card.querySelector<HTMLInputElement>(selector);
      if (live && live !== active && !this.writeTimers.has(this.writeKeyOf(live)) && live.value !== fresh.getAttribute("value")) {
        live.value = fresh.getAttribute("value") ?? "";
      }
    }
  }

  /** What follows the values as they are typed: each slot's Default badge and reset, the scale's problem. */
  private syncLive(card: HTMLElement, view: PrintSettingsView): void {
    const scale = card.querySelector<HTMLInputElement>("input[data-print-scale]");
    if (scale) {
      this.paintScaleProblem(scale);
    }
    for (const slot of view.slots) {
      const id = `${slot.region}.${slot.slot}`;
      // Anything typed is the author's own text, the default's words too: the badge goes at once, before the write lands.
      const authored = slot.authored || this.writeTimers.has(`slot:${id}`);
      const reset = card.querySelector<HTMLElement>(`[data-print-slot-reset="${id}"]`);
      const badge = card.querySelector<HTMLElement>(`[data-print-slot-default="${id}"]`);
      if (reset) {
        reset.hidden = !authored;
      }
      if (badge) {
        badge.hidden = authored;
      }
    }
  }

  /** The scale box's problem and its `aria-invalid`, read from what the box holds now (typed, or the form's value taken in place). */
  private paintScaleProblem(input: HTMLInputElement): { edits: readonly PrintEdit[] | undefined } {
    const edits = scaleEdits(input.value);
    const invalid = edits === undefined && input.value.trim() !== "";
    const problem = this.root.querySelector<HTMLElement>("[data-print-scale-problem]");
    if (problem) {
      problem.hidden = !invalid;
    }
    if (invalid) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
    return { edits };
  }

  private mainCardHtml(view: PrintSettingsView): string {
    const theme = this.printThemeValue?.label ?? this.t("printing.lead.basic");
    const versions = PRINT_RENDITIONS.map((rendition) => {
      const on = view.offered.includes(rendition);
      const last = on && view.offered.length === 1;
      return `<label class="row"><input type="checkbox" data-print-rendition="${rendition}"${on ? " checked" : ""}${last ? ` disabled aria-describedby="print-versions-last"` : ""} />
        <span class="row-text"><span>${esc(this.t(`printing.version.${rendition}`))}</span><span class="muted small">${esc(this.t(`printing.version.${rendition}.note`))}</span></span></label>`;
    }).join("");
    const defaults = view.offered
      .map((rendition) => `<option value="${rendition}"${rendition === view.defaultRendition ? " selected" : ""}>${esc(this.t(`printing.version.${rendition}`))}</option>`)
      .join("");
    const fields = this.ctrl ? printFieldOptions(this.ctrl.snapshot(), this.ctrl.currentLocale(), this.ctrl.definitionKinds(), labelSourcesOf(this.ctrl)) : [];
    const slotRows = view.slots
      .map((slot) => {
        const id = `${slot.region}.${slot.slot}`;
        const label = this.t(`printing.slot.${slot.region}.${slot.slot}`);
        const domId = `print-slot-${slot.region}-${slot.slot}`;
        const insertLabel = this.t("printing.insert.label", { slot: label });
        // A menu button, as the builder's other action menus: each placeholder a button, none applied by an arrow press.
        const item = (choice: string, text: string): string =>
          `<button type="button" class="menu-item" role="menuitem" tabindex="-1" data-print-insert-item="${esc(`${id}|${choice}`)}">${esc(text)}</button>`;
        const items = [
          item("title", this.t("printing.insert.title")),
          item("pages", this.t("printing.insert.pages")),
          item("date", this.t("printing.insert.date")),
          item("receipt", this.t("printing.insert.receipt")),
          fields.length > 0
            ? `<span class="insert-sep" role="separator"></span><span class="insert-group" role="group" aria-label="${esc(this.t("printing.insert.fields"))}">${fields
                .map((field) => item(`field:${field.path}`, field.label))
                .join("")}</span>`
            : ""
        ].join("");
        return `<div class="slot">
          <div class="slot-head"><label for="${domId}">${esc(label)}</label>
            <span class="badge" data-print-slot-default="${id}">${esc(this.t("printing.slot.default"))}</span></div>
          <input type="text" id="${domId}" data-print-slot="${id}" value="${esc(slot.value)}" spellcheck="false" autocomplete="off" />
          <div class="slot-tools">
            <span class="insert" data-print-insert-wrap="${id}">
              <button type="button" class="btn small" data-print-insert="${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${domId}-insert" aria-label="${esc(insertLabel)}">${esc(this.t("printing.insert.button"))} <span aria-hidden="true">▾</span></button>
              <span class="menu insert-menu" id="${domId}-insert" role="menu" aria-label="${esc(insertLabel)}" data-print-insert-menu="${id}" hidden>${items}</span></span>
            <button type="button" class="link-btn" data-print-slot-reset="${id}" aria-label="${esc(this.t("printing.slot.resetLabel", { slot: label }))}">${esc(this.t("printing.slot.reset"))}</button></div>
        </div>`;
      })
      .join("");
    const entries = this.ctrl ? componentPrintEntries(this.ctrl.snapshot(), this.ctrl.currentLocale(), labelSourcesOf(this.ctrl)) : [];
    const entryWords = (entry: (typeof entries)[number]): string =>
      [
        entry.settings.breakBefore ? this.t("printing.breaks.breakBefore") : undefined,
        entry.settings.keepTogether ? this.t("printing.breaks.keepTogether") : undefined,
        entry.settings.on === "screen" ? this.t("printing.breaks.on.screen") : entry.settings.on === "paper" ? this.t("printing.breaks.on.paper") : undefined,
        entry.settings.show === "always" ? this.t("printing.breaks.show.always") : entry.settings.show === "answered" ? this.t("printing.breaks.show.answered") : undefined
      ]
        .filter((word): word is string => word !== undefined)
        .join(" · ");
    const list =
      entries.length === 0
        ? `<p class="muted small" data-print-breaks-none tabindex="-1">${esc(this.t("printing.breaks.none"))}</p>`
        : `<ul class="entries" data-print-entries>${entries
            .map(
              (entry) => `<li class="entry" data-print-entry="${esc(entry.id)}"><span class="entry-text">
                <button type="button" class="row-link" data-print-show="${esc(entry.id)}" aria-label="${esc(this.t("printing.breaks.select", { label: entry.label }))}">${esc(entry.label)}</button>
                <span class="muted small">${esc(entryWords(entry))}</span></span>
                <button type="button" class="btn small" data-print-clear="${esc(entry.id)}" aria-label="${esc(this.t("printing.breaks.clearLabel", { label: entry.label }))}">${esc(this.t("printing.breaks.clear"))}</button></li>`
            )
            .join("")}</ul>`;
    const journey = this.sourcesValue.hasJourney?.() === true;
    return `<section class="card group">
        <h2 class="card-title" id="print-title">${esc(this.t("printing.title"))}</h2>
        <p class="card-lead">${esc(this.t("printing.lead", { theme }))}</p>
        <p class="muted small" data-print-exact>${esc(this.t("printing.exact"))}</p>
        ${this.pickerHtml()}
      </section>
      <section class="card group" aria-labelledby="print-versions-title" data-print-versions>
        <h3 class="card-heading" id="print-versions-title">${esc(this.t("printing.versions.title"))}</h3>
        ${versions}
        ${view.offered.length === 1 ? `<p class="muted small" id="print-versions-last">${esc(this.t("printing.versions.last"))}</p>` : ""}
        <label class="field"><span class="field-label">${esc(this.t("printing.versions.default"))}</span><select data-print-default>${defaults}</select></label>
      </section>
      <section class="card group" aria-labelledby="print-page-title" data-print-page>
        <h3 class="card-heading" id="print-page-title">${esc(this.t("printing.page.title"))}</h3>
        <label class="row"><input type="checkbox" data-print-title-first${view.titleOnFirstPage ? " checked" : ""} /><span>${esc(this.t("printing.page.titleOnFirst"))}</span></label>
        <label class="field"><span class="field-label">${esc(this.t("printing.page.scale"))}</span>
          <input type="number" data-print-scale min="25" max="200" step="5" value="${view.scalePercent}" aria-describedby="print-scale-problem" /></label>
        <p class="problem" id="print-scale-problem" data-print-scale-problem hidden>${esc(this.t("printing.page.scale.problem"))}</p>
        <p class="muted small">${esc(this.t("printing.page.host"))}</p>
      </section>
      <section class="card group" aria-labelledby="print-slots-title" data-print-slots>
        <h3 class="card-heading" id="print-slots-title">${esc(this.t("printing.slots.title"))}</h3>
        <p class="card-lead">${esc(this.t("printing.slots.lead"))}</p>
        ${slotRows}
        <p class="note" data-tone="warning"><strong>${esc(this.t("printing.slots.chromium.title"))}</strong>${esc(this.t("printing.slots.chromium"))}</p>
      </section>
      <section class="card group" aria-labelledby="print-breaks-title" data-print-breaks>
        <h3 class="card-heading" id="print-breaks-title">${esc(this.t("printing.breaks.title"))}</h3>
        <p class="card-lead">${esc(this.t("printing.breaks.lead"))}</p>
        ${list}
        ${journey ? `<label class="row"><input type="checkbox" data-print-journey-breaks${view.journeyPageBreaks ? " checked" : ""} /><span>${esc(this.t("printing.breaks.journey"))}</span></label>` : ""}
      </section>`;
  }

  /**
   * The keyboard's way to a component (the sheet answers a click only): every component that can
   * print, in the form's order, by its name and type. Choosing one opens its "On paper" fields as
   * a click on the sheet does; the first choice brings the form's settings back.
   */
  private pickerHtml(): string {
    const controller = this.ctrl!;
    const entries = printPickerEntries(controller.snapshot(), controller.currentLocale(), controller.definitionKinds(), labelSourcesOf(controller));
    const options = entries
      .map(
        (entry) =>
          `<option value="${esc(entry.id)}"${entry.id === this.selectedId ? " selected" : ""}>${"  ".repeat(entry.depth)}${esc(this.t("printing.pick.option", { label: entry.label, type: entry.type }))}</option>`
      )
      .join("");
    return `<label class="field pick"><span class="field-label">${esc(this.t("printing.pick.label"))}</span>
      <select data-print-pick><option value=""${this.selectedId === undefined ? " selected" : ""}>${esc(this.t("printing.pick.none"))}</option>${options}</select></label>`;
  }

  private componentCardHtml(id: string): string {
    const controller = this.ctrl!;
    const node = findNode(controller.snapshot(), id)!;
    const section = controller.inspectorModel(id)?.sections.find((entry) => entry.id === "print");
    const rows = section ? inspectorSectionRowsHtml(section, { problems: controller.problemsOf(id), words: this.words.options(), openHelp: this.openHelp }) : "";
    return `<section class="card group">
        <button type="button" class="btn small back" data-print-back aria-label="${esc(this.t("printing.component.backLabel"))}">‹ ${esc(this.t("printing.component.back"))}</button>
        <div data-print-component="${esc(id)}">
          <h2 class="card-title" id="print-title">${esc(componentLabel(node, controller.currentLocale(), labelSourcesOf(controller)))} <span class="badge">${esc(node.type)}</span></h2>
          <p class="card-lead">${esc(this.t("printing.component.lead"))}</p>
        </div>
        ${this.pickerHtml()}
      </section>
      <section class="card group" data-print-on-paper>${rows}</section>`;
  }

  // --- the toolbar -------------------------------------------------------------------------------

  private locales(): string[] {
    const codes = supportedLocaleCodes(this.ctrl?.localization());
    return codes.length > 0 ? codes : [this.ctrl?.currentLocale() ?? "en"];
  }

  private printLocale(): string {
    const locales = this.locales();
    return this.localeChoice !== undefined && locales.includes(this.localeChoice) ? this.localeChoice : (this.ctrl?.currentLocale() ?? locales[0] ?? "en");
  }

  private sampleOptionsHtml(): string {
    const value = sampleSourceValue(this.sample);
    const option = (source: PrintSampleSource, label: string): string => {
      const optionValue = sampleSourceValue(source);
      return `<option value="${esc(optionValue)}"${optionValue === value ? " selected" : ""}>${esc(label)}</option>`;
    };
    const parts = [option({ kind: "none" }, this.t("printing.sample.none")), option({ kind: "try" }, this.t("printing.sample.try"))];
    if (this.testsEnabledValue) {
      const entries = this.scenarioEntries();
      parts.push(
        `<optgroup label="${esc(this.t("printing.sample.tests"))}">${
          entries.length === 0
            ? `<option value="" disabled>${esc(this.t("printing.sample.noTests"))}</option>`
            : entries.map((entry) => option({ kind: "scenario", id: entry.id }, this.t("printing.sample.test", { name: entry.name }))).join("")
        }</optgroup>`
      );
    }
    parts.push(option({ kind: "pasted" }, this.t("printing.sample.pasted")));
    return parts.join("");
  }

  private paintToolbar(): void {
    const bar = this.root.querySelector<HTMLElement>("[data-print-toolbar]");
    if (!bar || !this.isConnected) {
      return;
    }
    const rendition = this.rendition;
    const locales = this.locales();
    const locale = this.printLocale();
    const versions = PRINT_RENDITIONS.map(
      (entry) => `<button type="button" data-print-version="${entry}" aria-pressed="${entry === rendition}">${esc(this.t(`printing.version.short.${entry}`))}</button>`
    ).join("");
    const languages =
      locales.length < 2
        ? ""
        : `<label class="field"><span class="field-label">${esc(this.t("printing.language"))}</span><select data-print-locale>${locales
            .map((code) => `<option value="${esc(code)}"${code === locale ? " selected" : ""}>${esc(localeDisplayName(code))}</option>`)
            .join("")}</select></label>`;
    const empty = !this.ctrl || !hasContent(this.ctrl.snapshot());
    const html = `<span class="seg" role="group" aria-label="${esc(this.t("printing.version.group"))}">${versions}</span>
      <span class="pages" data-print-pages></span>
      <span class="zoom">
        <button type="button" class="icon-btn" data-print-zoom="out" aria-label="${esc(this.t("printing.zoom.out"))}" data-tip="${esc(this.t("printing.zoom.out"))}">${zoomIcon("M5 12h14")}</button>
        <span class="zoom-value" data-print-zoom-value></span>
        <button type="button" class="icon-btn" data-print-zoom="in" aria-label="${esc(this.t("printing.zoom.in"))}" data-tip="${esc(this.t("printing.zoom.in"))}">${zoomIcon("M12 5v14M5 12h14")}</button>
        <button type="button" class="icon-btn tool-toggle" data-print-zoom="fit" aria-pressed="${this.zoomChoice === "fit"}">${esc(this.t("printing.zoom.fit"))}</button>
      </span>
      <button type="button" class="btn primary" data-print-test${empty ? " disabled" : ""}>${esc(this.t("printing.test"))}</button>`;
    // What the preview is drawn with sits in its own card beside the settings, not on the bar.
    const tools = `<label class="field"><span class="field-label">${esc(this.t("printing.sample.label"))}</span><select data-print-sample>${this.sampleOptionsHtml()}</select></label>
      ${languages}
      <label class="field"><span class="field-label">${esc(this.t("printing.paper"))}</span><select data-print-paper>${(Object.keys(PRINT_PAPERS) as PrintPaper[])
        .map((paper) => `<option value="${paper}"${paper === this.paper ? " selected" : ""}>${esc(this.t(`printing.paper.${paper}`))}</option>`)
        .join("")}</select></label>
      <button type="button" class="btn small receipt-toggle tool-toggle" data-print-receipt-toggle aria-expanded="${this.receiptOpen}" aria-controls="print-receipt-field">${esc(this.t("printing.receipt.toggle"))}${
        this.receiptText.trim() !== "" ? `<span class="receipt-dot" data-print-receipt-set aria-hidden="true"></span><span class="sr-only">${esc(this.t("printing.receipt.set"))}</span>` : ""
      }</button>`;
    const key = `${html}\u0000${tools}`;
    if (key !== this.toolbarKey) {
      const focus = this.captureFocus();
      bar.innerHTML = html;
      const side = this.root.querySelector<HTMLElement>("[data-print-preview-tools]");
      if (side) {
        side.innerHTML = tools;
      }
      this.toolbarKey = key;
      this.syncToolbarStop?.();
      this.restoreFocus(focus);
    }
    this.applyZoom();
    this.paintPages();
  }

  private paintPages(): void {
    const pages = this.root.querySelector<HTMLElement>("[data-print-pages]");
    // A form with nothing to print counts no pages, whatever sheet was drawn before it emptied.
    const shown = this.ctrl && hasContent(this.ctrl.snapshot()) ? this.preview?.shown : undefined;
    if (pages) {
      pages.textContent = shown ? this.words.plural("printing.pages", shown.pagination.pages, { paper: this.t(`printing.paper.${this.paper}`) }) : "";
    }
  }

  private paintSamples(): void {
    const box = this.root.querySelector<HTMLElement>("[data-print-samples]");
    if (!box) {
      return;
    }
    // Neither box shows until asked for: the pasted submission's for a pasted sample, the
    // receipt's behind the Preview card's button. Their text is the session's and stays across.
    const pasted = this.root.querySelector<HTMLElement>("[data-print-pasted-field]");
    const receipt = this.root.querySelector<HTMLElement>("[data-print-receipt-field]");
    const showPasted = this.sample.kind === "pasted";
    if (pasted) {
      pasted.hidden = !showPasted;
    }
    if (receipt) {
      receipt.hidden = !this.receiptOpen;
    }
    box.hidden = !showPasted && !this.receiptOpen;
    this.paintReading("[data-print-pasted]", "[data-print-pasted-error]", this.sample.kind === "pasted" ? readPastedAnswers(this.pastedText) : { empty: true }, "pasted");
    this.paintReading("[data-print-receipt]", "[data-print-receipt-error]", readReceiptData(this.receiptText), "receipt");
  }

  private paintReading(boxSelector: string, errorSelector: string, reading: PastedReading<unknown>, kind: "pasted" | "receipt"): void {
    const box = this.root.querySelector<HTMLTextAreaElement>(boxSelector);
    const error = this.root.querySelector<HTMLElement>(errorSelector);
    const failed = "error" in reading;
    if (failed) {
      box?.setAttribute("aria-invalid", "true");
    } else {
      box?.removeAttribute("aria-invalid");
    }
    if (error) {
      error.hidden = !failed;
      // An alert, said as it shows; written only when its words change, so the same error is not said again per keystroke.
      const text = failed ? this.t(`printing.${kind}.error.${reading.error}`) : "";
      if (error.textContent !== text) {
        error.textContent = text;
      }
    }
  }

  private paintEmpty(): void {
    const empty = !this.ctrl || !hasContent(this.ctrl.snapshot());
    const scroller = this.root.querySelector<HTMLElement>("[data-print-scroller]");
    const card = this.root.querySelector<HTMLElement>("[data-print-empty]");
    if (scroller) {
      scroller.hidden = empty;
    }
    if (card) {
      card.hidden = !empty;
    }
  }

  /** `selfCheckProblems`: why the sheet fell back to the basic theme after its own check (the sheet's, not the prepared print's). */
  private paintFallback(prepared: PreparedPrint | undefined, selfCheckProblems?: readonly string[]): void {
    const notice = this.root.querySelector<HTMLElement>("[data-print-fallback]");
    if (!notice) {
      return;
    }
    const fell = (prepared?.fellBack !== undefined && prepared.fellBack.length > 0) || (selfCheckProblems?.length ?? 0) > 0;
    const failed = this.problem !== undefined;
    notice.hidden = !fell && !failed;
    notice.textContent = failed
      ? (this.problem ?? "")
      : fell
        ? this.t("printing.fallback", { theme: this.printThemeValue?.label ?? this.printThemeValue?.id ?? prepared?.theme ?? "" })
        : "";
  }

  private applyZoom(): void {
    const preview = this.preview;
    if (!preview) {
      return;
    }
    if (this.zoomChoice === "fit") {
      const scroller = this.root.querySelector<HTMLElement>("[data-print-scroller]");
      const room = (scroller?.clientWidth ?? 0) - 32;
      preview.zoom = room > 0 ? Math.min(1, room / preview.paperWidth) : 1;
    } else {
      preview.zoom = this.zoomChoice;
    }
    const value = this.root.querySelector<HTMLElement>("[data-print-zoom-value]");
    const percent = this.t("printing.zoom.value", { percent: Math.round(preview.zoom * 100) });
    if (value && value.textContent !== percent) {
      value.textContent = percent;
    }
    this.root.querySelector<HTMLElement>('[data-print-zoom="fit"]')?.setAttribute("aria-pressed", String(this.zoomChoice === "fit"));
    // − with no smaller step left, + with no larger one: still pressable, they say they do nothing.
    this.root.querySelector<HTMLElement>('[data-print-zoom="out"]')?.setAttribute("aria-disabled", String(this.zoomStep(preview.zoom, -1) === undefined));
    this.root.querySelector<HTMLElement>('[data-print-zoom="in"]')?.setAttribute("aria-disabled", String(this.zoomStep(preview.zoom, 1) === undefined));
  }

  /** The zoom step past `now` in `direction`; `undefined` at the end of the range. */
  private zoomStep(now: number, direction: 1 | -1): number | undefined {
    return direction > 0 ? ZOOM_STEPS.find((step) => step > now + 0.001) : [...ZOOM_STEPS].reverse().find((step) => step < now - 0.001);
  }

  private stepZoom(direction: 1 | -1): void {
    const next = this.zoomStep(this.preview?.zoom ?? 1, direction);
    if (next === undefined) {
      // Past the last step (a Fit below the smallest, the largest already): the zoom stays as it is.
      return;
    }
    this.zoomChoice = next;
    this.applyZoom();
  }

  // --- events -------------------------------------------------------------------------------------

  private onControllerChange(event: BuilderChangeEvent | undefined): void {
    const reason = event?.reason;
    if (reason === "init" || event?.historyStep !== undefined) {
      // Another document in the same controller, or a step taken back or made again: a value typed
      // for what was there is not written into what is there now. The boxes show the form's values.
      this.cancelWrites();
      if (reason === "init") {
        this.selectedId = undefined;
        this.openHelp.clear();
        this.scenarios = undefined;
        this.forgetReplays();
      }
    }
    if (reason !== "select" && reason !== "preview") {
      // A scenario's replay is of the form as it was (its ids, data keys, defaults, rules) and of
      // its tests block: any edit, made here or while Print is hidden, replays it afresh.
      this.forgetReplays();
      if (this.scenarios && this.scenarios.key !== this.testsKey()) {
        this.scenarios = undefined;
      }
    }
    if (!this.shownValue || !this.isConnected) {
      // Hidden: nothing is drawn now; the sheet and the card are drawn when the surface is back.
      this.dirty = true;
      return;
    }
    if (reason === "select") {
      // A selection made elsewhere (an undo, an agent) does not take the card over; one the card shows that went is let go.
      if (this.selectedId !== undefined && this.ctrl && !findNode(this.ctrl.snapshot(), this.selectedId)) {
        this.selectedId = undefined;
        this.paintSettings();
      }
      this.preview?.markSelected(this.selectedId);
      return;
    }
    this.paintSettings();
    this.paintToolbar();
    this.paintEmpty();
    this.scheduleRefresh(REFRESH_PAUSE_MS);
  }

  /**
   * Opens `id`'s "On paper" fields and selects it on the controller: a click on the sheet, a
   * Show in the list, a choice in the picker. The sheet scrolls to it; focus goes to the card's
   * Back, or stays on the picker it was chosen in (`from: "picker"`).
   */
  private selectFromSheet(id: string, from: "sheet" | "picker" = "sheet"): void {
    const controller = this.ctrl;
    if (!controller || id === controller.rootId() || !findNode(controller.snapshot(), id)) {
      return;
    }
    this.flushWrites();
    if (id !== this.selectedId) {
      this.openHelp.clear();
    }
    this.selectedId = id;
    controller.select(id);
    this.paintSettings();
    this.preview?.markSelected(id);
    if (from === "picker") {
      this.scrollSheetTo(id);
      this.root.querySelector<HTMLElement>("select[data-print-pick]")?.focus();
    } else {
      this.root.querySelector<HTMLElement>("[data-print-back]")?.focus();
    }
  }

  /** Back to the form's print settings from a component's card. */
  private showFormSettings(focus: "back" | "picker"): void {
    this.flushWrites();
    const left = this.selectedId;
    this.selectedId = undefined;
    this.openHelp.clear();
    this.paintSettings();
    this.preview?.markSelected(undefined);
    // Back goes to the component left, as it stands in the list, else to the picker every card has.
    const listed = focus === "back" && left !== undefined ? this.root.querySelector<HTMLElement>(`button[data-print-show="${cssString(left)}"]`) : null;
    (listed ?? this.root.querySelector<HTMLElement>("select[data-print-pick]"))?.focus();
  }

  /** The sheet's scroller brought to `id`'s box, a little above it. */
  private scrollSheetTo(id: string): void {
    const scroller = this.root.querySelector<HTMLElement>("[data-print-scroller]");
    const box = this.root.querySelector<HTMLElement>("[data-print-zoom-box]");
    const top = this.preview?.topOf(id);
    if (!scroller || !box || top === undefined) {
      return;
    }
    const zoom = this.preview?.zoom ?? 1;
    scroller.scrollTop = Math.max(0, box.offsetTop + top * zoom - 24);
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const hit = (selector: string): HTMLElement | null => target?.closest?.(selector) ?? null;
    const controller = this.ctrl;
    const insertButton = hit("[data-print-insert]");
    if (insertButton) {
      const id = insertButton.dataset.printInsert!;
      if (this.insertOpen === id) {
        this.closeInsertMenu();
      } else {
        this.openInsertMenu(id, "first");
      }
      return;
    }
    const insertItem = hit("[data-print-insert-item]");
    if (insertItem) {
      const value = insertItem.dataset.printInsertItem!;
      const split = value.indexOf("|");
      this.closeInsertMenu();
      // Focus goes to the slot box, after the placeholder put in.
      this.insertIntoSlot(value.slice(0, split), value.slice(split + 1));
      return;
    }
    if (hit("[data-print-back]")) {
      this.showFormSettings("back");
      return;
    }
    const show = hit("[data-print-show]");
    if (show) {
      this.selectFromSheet(show.dataset.printShow!);
      return;
    }
    const clear = hit("[data-print-clear]");
    if (clear && controller) {
      const id = clear.dataset.printClear!;
      const label = this.labelOf(id);
      // The entry leaves the list: focus goes on to the next entry's Clear, else the one before.
      const entry = clear.closest("[data-print-entry]");
      const neighbour = (entry?.nextElementSibling ?? entry?.previousElementSibling)?.querySelector<HTMLElement>("[data-print-clear]")?.dataset.printClear;
      this.flushWrites();
      controller.setProperties(clearComponentPrintEdits(id));
      this.say(this.t("printing.say.cleared", { label }));
      // The change painted the card at once; the list's "none" line takes focus once it is empty.
      const next =
        (neighbour !== undefined ? this.root.querySelector<HTMLElement>(`button[data-print-clear="${cssString(neighbour)}"]`) : null) ??
        this.root.querySelector<HTMLElement>("[data-print-breaks-none]");
      if (next && !this.root.activeElement) {
        next.focus();
      }
      return;
    }
    const reset = hit("[data-print-slot-reset]");
    if (reset) {
      const [region, slot] = reset.dataset.printSlotReset!.split(".") as [PrintRegion, PrintSlotName];
      this.cancelWrite(`slot:${region}.${slot}`);
      this.write(slotResetEdits(region, slot));
      const input = this.root.querySelector<HTMLInputElement>(`[data-print-slot="${region}.${slot}"]`);
      if (input) {
        // The box shows the default again: what prints there now.
        input.value = this.view().slots.find((entry) => entry.region === region && entry.slot === slot)?.value ?? "";
        input.focus();
      }
      const card = this.root.querySelector<HTMLElement>("[data-print-settings]");
      if (card) {
        this.syncLive(card, this.view());
      }
      return;
    }
    const help = hit("[data-help-toggle]");
    if (help) {
      const open = help.getAttribute("aria-expanded") !== "true";
      help.setAttribute("aria-expanded", String(open));
      // Kept open across the card's paints (a box ticked below it draws the card again).
      const path = help.getAttribute("data-help-toggle") ?? "";
      if (open) {
        this.openHelp.add(path);
      } else {
        this.openHelp.delete(path);
      }
      const paragraph = this.root.getElementById(help.getAttribute("aria-controls") ?? "");
      if (paragraph) {
        paragraph.hidden = !open;
      }
      return;
    }
    const version = hit("[data-print-version]");
    if (version) {
      this.version = version.dataset.printVersion as PrintRendition;
      this.paintToolbar();
      this.scheduleRefresh(0);
      return;
    }
    const zoom = hit("[data-print-zoom]");
    if (zoom) {
      const which = zoom.dataset.printZoom;
      if (which === "fit") {
        this.zoomChoice = "fit";
        this.applyZoom();
      } else {
        this.stepZoom(which === "in" ? 1 : -1);
      }
      return;
    }
    if (hit("[data-print-receipt-toggle]")) {
      this.receiptOpen = !this.receiptOpen;
      this.paintToolbar();
      this.paintSamples();
      return;
    }
    if (hit("[data-print-test]")) {
      void this.printTestPage();
    }
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.printSlot !== undefined) {
      const [region, slot] = target.dataset.printSlot.split(".") as [PrintRegion, PrintSlotName];
      const value = target.value;
      this.deferWrite(`slot:${region}.${slot}`, () => this.write(slotEdits(region, slot, value)));
      const card = this.root.querySelector<HTMLElement>("[data-print-settings]");
      if (card) {
        this.syncLive(card, this.view());
      }
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.printScale !== undefined) {
      const { edits } = this.paintScaleProblem(target);
      if (edits) {
        this.deferWrite("scale", () => this.write(edits));
      } else {
        this.cancelWrite("scale");
      }
      return;
    }
    if ((target instanceof HTMLInputElement && target.type === "text") || target instanceof HTMLTextAreaElement) {
      if (target.dataset.prop !== undefined && this.selectedId !== undefined) {
        const id = this.selectedId;
        const path = target.dataset.prop;
        const value = target.value;
        this.deferWrite(`prop:${id}:${path}`, () => this.writeComponent(id, path, value === "" ? undefined : value));
        return;
      }
      if (target.hasAttribute("data-print-pasted")) {
        this.pastedText = (target as HTMLTextAreaElement).value;
        this.paintSamples();
        this.scheduleRefresh(REFRESH_PAUSE_MS);
        return;
      }
      if (target.hasAttribute("data-print-receipt")) {
        this.receiptText = (target as HTMLTextAreaElement).value;
        this.paintToolbar();
        this.paintSamples();
        this.scheduleRefresh(REFRESH_PAUSE_MS);
      }
    }
  }

  private onChangeEvent(event: Event): void {
    const target = event.target as HTMLElement;
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.printSlot !== undefined) {
      this.flushWrite(`slot:${target.dataset.printSlot}`);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.printScale !== undefined) {
      this.flushWrite("scale");
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.printRendition !== undefined) {
      const edits = renditionToggleEdits(controller.snapshot().configuration, target.dataset.printRendition as PrintRendition, target.checked);
      if (edits === undefined) {
        target.checked = true;
        this.say(this.t("printing.versions.last"));
        return;
      }
      this.write(edits);
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-print-default")) {
      this.write(defaultRenditionEdits(controller.snapshot().configuration, target.value as PrintRendition));
      return;
    }
    if (target instanceof HTMLInputElement && target.hasAttribute("data-print-title-first")) {
      this.write(titleOnFirstPageEdits(target.checked));
      return;
    }
    if (target instanceof HTMLInputElement && target.hasAttribute("data-print-journey-breaks")) {
      this.write(journeyPageBreaksEdits(target.checked));
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-print-pick")) {
      if (target.value === "") {
        this.showFormSettings("picker");
      } else {
        this.selectFromSheet(target.value, "picker");
      }
      return;
    }
    if (target.dataset.prop !== undefined && this.selectedId !== undefined) {
      const id = this.selectedId;
      const path = target.dataset.prop;
      if (target instanceof HTMLInputElement && target.type === "checkbox") {
        this.writeComponent(id, path, target.checked ? true : undefined);
      } else if (target instanceof HTMLSelectElement) {
        this.writeComponent(id, path, target.value === "" ? undefined : target.value);
      } else {
        this.flushWrite(`prop:${id}:${path}`);
      }
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-print-sample")) {
      this.sample = readSampleSourceValue(target.value);
      this.paintSamples();
      if (this.sample.kind === "pasted") {
        this.root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")?.focus();
      }
      this.scheduleRefresh(0);
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-print-locale")) {
      this.localeChoice = target.value;
      this.scheduleRefresh(0);
      return;
    }
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-print-paper")) {
      this.paper = (target.value in PRINT_PAPERS ? target.value : "letter") as PrintPaper;
      this.scheduleRefresh(0);
    }
  }

  /** An insert shortcut, chosen: its placeholder at the slot box's caret, written, the box focused after it. */
  private insertIntoSlot(id: string, choice: string): void {
    const input = this.root.querySelector<HTMLInputElement>(`[data-print-slot="${id}"]`);
    if (!input || choice === "") {
      return;
    }
    const [insert, path] = choice.startsWith("field:") ? (["field", choice.slice("field:".length)] as const) : ([choice, undefined] as const);
    const text = insertionText(insert as PrintSlotInsert, this.pageNumberWords(), path);
    if (text === "") {
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = insertAt(input.value, start, end, text);
    input.value = next.text;
    const [region, slot] = id.split(".") as [PrintRegion, PrintSlotName];
    this.cancelWrite(`slot:${id}`);
    this.write(slotEdits(region, slot, next.text));
    input.focus();
    if (insert === "receipt") {
      // The path is the author's to name: it is selected, ready to be typed over.
      const from = next.caret - "}}".length - "reference".length;
      input.setSelectionRange(from, from + "reference".length);
    } else {
      input.setSelectionRange(next.caret, next.caret);
    }
  }

  // --- writes ---------------------------------------------------------------------------------------

  private writeKeyOf(input: HTMLInputElement): string {
    if (input.dataset.printSlot !== undefined) {
      return `slot:${input.dataset.printSlot}`;
    }
    if (input.dataset.printScale !== undefined) {
      return "scale";
    }
    return input.dataset.prop !== undefined && this.selectedId !== undefined ? `prop:${this.selectedId}:${input.dataset.prop}` : "";
  }

  /** The form root's print settings, one undo step. */
  private write(edits: readonly PrintEdit[]): void {
    const controller = this.ctrl;
    if (!controller || edits.length === 0) {
      return;
    }
    // A cleared setting leaves no empty block behind, and a write that changes nothing makes no undo step.
    const settled = settledPrintEdits(controller.snapshot().configuration, edits);
    if (settled.length === 0) {
      return;
    }
    const rootId = controller.rootId();
    try {
      controller.setProperties(settled.map((edit) => ({ componentId: rootId, propertyPath: edit.propertyPath, value: edit.value })));
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }

  private writeComponent(id: string, path: string, value: unknown): void {
    const controller = this.ctrl;
    if (!controller || !findNode(controller.snapshot(), id)) {
      return;
    }
    try {
      controller.setProperty(id, path, value);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }

  private deferWrite(key: string, run: () => void): void {
    const pending = this.writeTimers.get(key);
    if (pending) {
      clearTimeout(pending.timer);
    }
    const timer = setTimeout(() => {
      this.writeTimers.delete(key);
      run();
    }, WRITE_PAUSE_MS);
    this.writeTimers.set(key, { timer, run });
  }

  private flushWrite(key: string): void {
    const pending = this.writeTimers.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.writeTimers.delete(key);
      pending.run();
    }
  }

  private cancelWrite(key: string): void {
    const pending = this.writeTimers.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.writeTimers.delete(key);
    }
  }

  /**
   * Every typed value still waiting its pause (a slot, the scale, a note) written now, each as the
   * step it would have been. The shell calls it before it saves or reads the definition to hand
   * on; with nothing waiting it does nothing.
   */
  public flushWrites(): void {
    for (const key of [...this.writeTimers.keys()]) {
      this.flushWrite(key);
    }
  }

  /** Every typed value still waiting dropped, unwritten; the boxes take the form's values at the next paint. */
  private cancelWrites(): void {
    if (this.writeTimers.size === 0) {
      return;
    }
    for (const key of [...this.writeTimers.keys()]) {
      this.cancelWrite(key);
    }
    // The box typed in takes the form's value at the next paint, focused or not.
    this.staleTyping = true;
  }

  /**
   * Ctrl or Cmd+Z undoes, Shift+Z and Y redo: the form's history from anywhere in the surface (the
   * browser's own undo of a box's text does not run), through {@link historyStep} when the shell
   * set it. A typed value still waiting is written first, so the step taken back is the typing;
   * every box then shows the form's value, the one typed in too. The pasted submission and the
   * sample receipt are the session's, never the form's: in them the keys are the browser's text undo.
   */
  private onKeydown(event: KeyboardEvent): void {
    const key = event.key?.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-print-pasted], [data-print-receipt]")) {
        return;
      }
      event.preventDefault();
      this.flushWrites();
      const controller = this.ctrl;
      if (!controller) {
        return;
      }
      // The paint the step makes gives the focused box the form's value, not what was typed.
      this.staleTyping = true;
      const direction = key === "y" || event.shiftKey ? "redo" : "undo";
      if (this.historyStep) {
        this.historyStep(controller, direction);
      } else if (direction === "undo") {
        controller.undo();
      } else {
        controller.redo();
      }
      if (this.staleTyping) {
        // Nothing stepped on this form (no paint came): the boxes are put back to its values all the same.
        this.paintSettings();
      }
      return;
    }
    this.onInsertKeydown(event);
  }

  // --- samples -------------------------------------------------------------------------------------

  private testsKey(): string {
    try {
      return JSON.stringify(this.ctrl?.tests() ?? null);
    } catch {
      return "";
    }
  }

  /** Every scenario's replayed answers let go, a replay still running too: the next draw replays afresh. */
  private forgetReplays(): void {
    this.scenarioValues.clear();
    this.replayGeneration += 1;
  }

  /** The scenarios offered as samples: loaded through the Tests chunk once the form has tests. */
  private scenarioEntries(): Array<{ id: string; name: string }> {
    const tests = this.ctrl?.tests();
    const has = Array.isArray(tests?.scenarios) && tests.scenarios.length > 0;
    if (!this.testsEnabledValue || !has) {
      return [];
    }
    const key = this.testsKey();
    if (this.scenarios?.key === key) {
      return this.scenarios.entries.filter((entry) => entry.scenario !== undefined).map((entry) => ({ id: entry.id, name: entry.name }));
    }
    if (!this.scenariosLoading) {
      this.scenariosLoading = true;
      void loadTestsPanel().then(
        (module) => {
          this.scenariosLoading = false;
          const controller = this.ctrl;
          if (!controller) {
            return;
          }
          const runner = module.createTestsRunner({
            definition: () => this.definitionSource?.(),
            root: () => controller.snapshot(),
            functions: () => this.functionsSource?.functions?.(),
            signatures: () => this.functionsSource?.signatures(),
            dataSources: () => controller.dataSources()
          });
          let entries: TestsEntryModel[] = [];
          try {
            entries = runner.parse(controller.tests());
          } catch {
            entries = [];
          }
          this.scenarios = { key: this.testsKey(), entries, runner };
          // Replays were of the scenarios parsed before: none carries over.
          this.forgetReplays();
          this.paintToolbar();
        },
        () => {
          this.scenariosLoading = false;
        }
      );
    }
    return [];
  }

  /** The answers of the sample chosen, as the store holds them; `{}` for none. Never throws. */
  private async sampleValues(): Promise<Record<string, unknown>> {
    const sample = this.sample;
    try {
      if (sample.kind === "try") {
        return { ...(this.sourcesValue.tryAnswers?.() ?? {}) };
      }
      if (sample.kind === "pasted") {
        const reading = readPastedAnswers(this.pastedText);
        return "value" in reading ? reading.value : {};
      }
      if (sample.kind === "scenario") {
        const cached = this.scenarioValues.get(sample.id);
        if (cached) {
          return cached;
        }
        const entry = this.scenarios?.entries.find((candidate) => candidate.id === sample.id);
        if (!entry?.scenario || !this.scenarios) {
          return {};
        }
        const generation = this.replayGeneration;
        const replay = await this.scenarios.runner.replay(entry.scenario, Math.max(0, entry.scenario.steps.length - 1));
        const values = isRecord(replay.values) ? replay.values : {};
        // An edit while the replay ran let the replays go: this one is of the form before it, drawn
        // once (the draw the edit scheduled replays afresh) and never kept.
        if (generation === this.replayGeneration) {
          this.scenarioValues.set(sample.id, values);
        }
        return values;
      }
    } catch {
      return {};
    }
    return {};
  }

  /**
   * A runtime for `values` over the form as it stands: a journey's own when the form opens as
   * one, once it runs (a journey that cannot run prints the form whole). `isCurrent` says whether
   * the draw that asked is still the latest: a session made for one that was overtaken is let go.
   */
  private async makeRuntime(values: Record<string, unknown>, isCurrent: () => boolean): Promise<SampleRuntime | undefined> {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    let session: BuilderPrintSession | undefined;
    try {
      session = this.sourcesValue.journeySession?.(kernelJsonAnswers(values));
    } catch {
      session = undefined;
    }
    if (session) {
      await session.ready().catch(() => undefined);
      const runtime = session.runtime;
      if (!isCurrent() || !runtime) {
        session.dispose();
        if (!isCurrent()) {
          return undefined;
        }
      } else {
        this.applyHostContext(runtime);
        const made = session;
        return { runtime, session: true, dispose: () => made.dispose() };
      }
    }
    const functions = this.functionsSource?.functions?.();
    const runtime = new BuilderPreviewRuntime(controller.snapshot(), {
      ...(controller.dataSourceResolver() ? { dataSourceResolver: controller.dataSourceResolver() } : {}),
      ...(controller.dataSources() ? { dataSources: controller.dataSources() } : {}),
      ...(functions !== undefined ? { functions } : {}),
      signatures: formulaSignatures(this.functionsSource),
      locale: controller.currentLocale(),
      ...(controller.translations() !== undefined ? { translations: controller.translations() } : {}),
      ...(controller.translationCatalog() !== undefined ? { translationCatalog: controller.translationCatalog() } : {}),
      localization: () => controller.localization()
    });
    if (Object.keys(values).length > 0) {
      runtime.replaceValues(values);
    }
    this.applyHostContext(runtime);
    return { runtime, session: false };
  }

  /** The host values Try it's Settings give (preview state, never the form's): what `{{host.<key>}}` prints on the sheet. */
  private applyHostContext(runtime: RenderHostRuntime): void {
    const target = runtime as { setHostContext?(context: Record<string, unknown> | undefined): void };
    try {
      target.setHostContext?.(this.ctrl?.tryHostContext());
    } catch {
      // A runtime that refuses the values prints without them.
    }
  }

  private renderer(): DatumFormRendererElement {
    if (!this.rendererEl) {
      defineDatumFormRendererElement();
      // Never on the page: it builds documents, it draws no form. Its datum-print is sent on from the surface.
      const element = this.ownerDocument.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
      element.addEventListener("datum-print", (event) => {
        const original = event as CustomEvent<DatumPrintDetail>;
        const relayed = new CustomEvent<DatumPrintDetail>("datum-print", { detail: original.detail, bubbles: true, composed: true, cancelable: true });
        if (!this.dispatchEvent(relayed)) {
          original.preventDefault();
        }
      });
      this.rendererEl = element;
    }
    return this.rendererEl;
  }

  // --- the sheet ------------------------------------------------------------------------------------

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (!this.shownValue || !this.isConnected) {
      // Hidden or off the page: drawn when it is back.
      this.dirty = true;
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.inFlight = this.refresh();
    }, delay);
  }

  /** Draws the sheet for the form as it stands, the chosen version, sample, language and paper. */
  private async refresh(): Promise<void> {
    const token = ++this.refreshToken;
    const controller = this.ctrl;
    if (!controller || !this.isConnected || !this.preview || !this.shownValue) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    this.paintEmpty();
    if (!hasContent(controller.snapshot())) {
      // Nothing to print: no document, no page count, no notice of a sheet that is gone.
      this.problem = undefined;
      this.lastPrepared = undefined;
      this.paintFallback(undefined);
      this.paintPages();
      return;
    }
    const values = await this.sampleValues();
    if (token !== this.refreshToken) {
      return;
    }
    const made = await this.makeRuntime(values, () => token === this.refreshToken);
    if (!made || token !== this.refreshToken) {
      made?.dispose?.();
      return;
    }
    const renderer = this.renderer();
    try {
      this.sourcesValue.configureRenderer?.(renderer);
    } catch {
      // The canvas's set-up is a nicety: the sheet still draws in Datum's own look without it.
    }
    renderer.printTheme = this.printThemeValue;
    // A session's runtime knows no data sources of the builder's: the form's go on the renderer,
    // as the canvas's do while Try it runs a session; the preview runtime holds its own.
    const sources = made.session ? controller.dataSources() : undefined;
    if (renderer.dataSources !== sources) {
      renderer.dataSources = sources;
    }
    const receipt = readReceiptData(this.receiptText);
    renderer.notice = "value" in receipt ? { data: receipt.value } : undefined;
    const previous = this.current;
    this.current = made;
    renderer.runtime = made.runtime;
    previous?.dispose?.();
    let prepared: PreparedPrint | undefined;
    let shown: PrintShown | undefined;
    try {
      prepared = await renderer.preparePrintDocument({ rendition: this.rendition, page: { size: this.paper }, locale: this.printLocale() });
      this.problem = undefined;
    } catch (error) {
      this.problem = `${this.t("printing.failed")} ${error instanceof Error ? error.message : ""}`.trim();
      prepared = undefined;
    }
    if (token !== this.refreshToken) {
      return;
    }
    if (prepared) {
      this.lastPrepared = prepared;
      shown = await this.preview.show(prepared, this.paper);
      if (token !== this.refreshToken) {
        return;
      }
      this.preview.markSelected(this.selectedId);
    }
    this.paintFallback(prepared, shown?.fellBack);
    this.paintPages();
    this.applyZoom();
  }

  /** "Print a test page": the version, paper and language on show, through the renderer's own print. */
  private async printTestPage(): Promise<void> {
    await this.previewSettled();
    const renderer = this.rendererEl;
    if (!renderer?.runtime) {
      return;
    }
    try {
      await renderer.print({ rendition: this.rendition, page: { size: this.paper }, locale: this.printLocale() });
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }
}

export function defineBuilderPrint(): void {
  if (canDefineCustomElements() && !customElements.get(DATUM_BUILDER_PRINT_TAG)) {
    customElements.define(DATUM_BUILDER_PRINT_TAG, DatumBuilderPrintElement);
  }
}

defineBuilderPrint();
