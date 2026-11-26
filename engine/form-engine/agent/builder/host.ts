/**
 * The builder catalogue's host seam: what the tools read from and act through, so the catalogue
 * stays pure over `BuilderController` and never touches the DOM. `<datum-form-builder>`'s
 * element host (packages/datum, `src/builder/agent-host.ts`) implements it with the shell, the
 * banner, the live region and the notice; {@link createControllerHost} implements it over a
 * bare controller for the engine's tests, with no page (`ui` absent).
 *
 * `shellLoaders()` hands the element host the shell's own lazy-chunk loaders: the same module
 * instances the shell uses, so a chunk the person already opened counts as loaded for the
 * agent too, and no deep path of the engine has to be exported for it. It also holds
 * the data-model planner's loader (`loadDataModelKit`), fetched only by `fromData` and
 * `get_definition { section: "data-model" }`.
 *
 * The page seam also carries 1:1 adapters over the
 * Try it canvas and the two designer modes: each adapter member is one call on the shell, the
 * canvas or a mode, so `agent/builder/` holds no mode object and imports the mode modules for
 * their types only. Every new member is optional: a host built without them still type-checks,
 * and a tool whose seam is absent answers `no-ui` or `feature-off` as its guards say.
 *
 * Nothing here runs at import time.
 */
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { DataSourceSet } from "../../core/schema/contracts.js";
import type { FormDefinition } from "../../core/schema/types.js";
import type { Journey, JourneyConfiguration } from "../../core/schema/journey.js";
import type { PdfConfiguration, PdfLayoutDocument, PdfTemplateLayout, PdfTemplateSource } from "../../core/schema/pdf-layout.js";
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { loadDataModelPlan, type DataModelPlanModule } from "../../builder/data/data-model-plan-loader.js";
import { formulaEditorLoaded, type FormulaEditorModule } from "../../builder/formula/formula-editor-loader.js";
import { BuilderWords } from "../../builder/logic/builder-texts.js";
import type { BuilderFeature } from "../../builder/web-component/builder-features.js";
import { loadTestsPanel, type TestsPanelModule } from "../../builder/web-component/tests-panel-loader.js";
import type { BuilderAgentLanguageInputs, BuilderSaveOutcome, BuilderWorkspace } from "../../builder/web-component/default-builder-element.js";
import type { FormulaFunctionsSource } from "../../builder/web-component/builder-panels.js";
import type { BuilderDocument, BuilderTrySession } from "../../builder/web-component/builder-modes.js";
import type { TryCheckOutcome, TrySubmitOutcome } from "../../builder/web-component/try-it-types.js";
import type { JourneyBuilderMode, NewJourneyOptions } from "../../builder/journey-designer/journey-builder-mode.js";
import type { CreateFormFieldsOptions, CreateFormFieldsResult, NewPdfLayoutOptions, PdfBuilderMode, PdfOpenState, PdfPreviewReport, PdfPreviewReportOptions, SuggestMappingsOptions } from "../../builder/pdf-designer/pdf-builder-mode.js";
import type { PdfLayoutFinding } from "../../builder/pdf-designer/layout-conditions.js";
import type { JourneyDiagnostic } from "../../core/journey/journey-diagnostics.js";
import type { AgentEventType } from "../tool-types.js";
import type { DesignerState } from "./types.js";

/** What `run_tests` needs from the tests chunk: the runner and the words that word its results. */
export type TestsChunk = Pick<TestsPanelModule, "createTestsRunner" | "createTestsWords" | "createTestsNaming">;

/**
 * The data-model planner (`builder/data/data-model-plan.ts`): the reader, the add / replace plans and the form's own data model. Fetched through
 * `loadDataModelKit`, never imported by value from `agent/builder/`.
 */
export type DataModelKit = DataModelPlanModule;

/** The runtime Try it draws (the canvas preview, or a journey session's): `RenderHostRuntime`. */
export type TriedRuntime = BuilderTrySession["runtime"];

/** What the PDF previews render from (Try it's answers, or the host's sample ones). */
export type PdfPreviewRuntime = NonNullable<PdfPreviewReportOptions["runtime"]>;

/** How a journey or a layout opens in its designer, as the shell's document waiter answers. */
export type SelectDocumentOutcome = { status: "opened" } | { status: "failed"; message: string } | { status: "timeout" };

/** One fillable PDF the site offers as a template (`wrapper.pdfTemplates.list()`). */
export interface PdfTemplateOption {
  templateId: string;
  label: string;
  source: PdfTemplateSource;
}

/**
 * Try it as the agent drives it: each member is
 * one call on the canvas, the shell or the Try it chunk (CANVAS `agentTryParts()`), so the try
 * body never reaches past this seam. Answers for the tried runtime, which during a journey's
 * Try it is the session's, not the canvas preview.
 */
export interface TryItAdapter {
  /** BHOST `canTry()`, widened: the try-it feature and a tryable surface (`builder.tryable`). */
  tryable(): boolean;
  trying(): boolean;
  /** `SHELL.setTrying(true)`, after the caller's pre-check said nothing holds; false: the shell held it. */
  start(): boolean;
  /** Painted, and in a journey designer the session's own `ready()` (CANVAS `tryReady`). */
  ready(): Promise<void>;
  /** CANVAS `triedRuntime()`: the session's runtime during a journey's Try it, else the preview. */
  runtime(): TriedRuntime | undefined;
  /** The tried runtime's own `state().values` and `dirty`. */
  typed(): { values: Record<string, unknown>; dirty: ReadonlySet<string> };
  where(): { workspace: "form" | "journeys" | "pdf"; journeyId?: string };
  /** CANVAS `tryPageIdOf`: a page node of the session's runtime to the journey's own page id. */
  pageIdOf(nodeId: string): string | undefined;
  /** CANVAS `tryNodeIdOf`: the inverse. */
  nodeIdOf(pageId: string): string | undefined;
  /** CANVAS `quietTriedPageFocus`: the tried renderer's quiet page focus; call the release once the move settles. */
  quietPageFocus(): () => void;
  /** CANVAS `focusedTriedPath`: the caret control the person types in, while the page has focus. */
  focusedPath(): string | undefined;
  /** CANVAS `tryRecording`: a test is being recorded from Try it. */
  recording(): boolean;
  /** CANVAS `tryShowing`: Try it shows a test scenario. */
  showing(): boolean;
  /** CANVAS `tryServerChecks`: the person's server-check switch, read, never set. */
  serverChecks(): "off" | "on";
  /** CANVAS `onTrySubmit`: hears `builder-try-submit` (anyone's Submit), for `read`'s `lastSubmit`. */
  onSubmit(listener: (outcome: TrySubmitOutcome) => void): () => void;
  /** CANVAS `agentTryCheck`: the person's Check, drawn on the Try panel; rejects when the chunk cannot load. */
  check(): Promise<TryCheckOutcome>;
  /** CANVAS `agentTrySubmit`: the person's Submit, quiet while their focus is elsewhere; `{ state: "busy" }` while one runs. */
  submit(): Promise<TrySubmitOutcome | { state: "busy" }>;
  /** CANVAS `clearTriedAnswers`: also ends a showing and resets the panel. */
  clear(): void;
  /** CANVAS `tryChunkState`: the Try it chunk's load state; `"off"` with the feature off. */
  chunk(): "ready" | "loading" | "failed" | "off";
}

/** A designer whose mode is on the page and answers. */
export interface DesignerAdapter<A> {
  state: "ready";
  /** The workspace the designer lives in (`"journeys"`, `"pdf"`). */
  workspace(): string;
  /** The document open in the designer, if any. */
  openId(): string | undefined;
  /** The open document's controller (a journey's or a layout's); undefined without one. */
  controller(): BuilderController | undefined;
  actions: A;
}

/** A designer side as `ui.journeys()` / `ui.pdfLayouts()` answer it: ready with its actions, or why not. */
export type DesignerSide<A> = DesignerAdapter<A> | { state: Exclude<DesignerState, "ready"> };

/**
 * The journeys' actions, 1:1 over the Journeys mode (JBM). `configuration()` reads the mode's
 * public `journeyConfiguration` getter (never its reseeding setter), so the outside journal can
 * compute an exact `applyCatalog`. No `defaultNewName`: `newJourney`
 * names a blank `name` itself.
 */
export interface JourneyActions {
  /** `documents.list()`: the journeys as the documents dropdown shows them. */
  list(): BuilderDocument[];
  opensAs(): JourneyBuilderMode["opensAs"];
  journeys(): Journey[];
  configuration(): JourneyConfiguration | undefined;
  newJourney(options: NewJourneyOptions): Promise<Journey>;
  addJourney(journey: Journey): void;
  rename(id: string, name: string): void;
  duplicate(id: string, options?: Parameters<JourneyBuilderMode["duplicateJourney"]>[1]): Journey;
  chooseOpensAs(id: string): void;
  remove(id: string): void;
  /** JBM `applyCatalogForAgent`: designers follow, histories kept. */
  applyCatalog(next: JourneyConfiguration | undefined, subjectId: string | undefined): void;
}

/**
 * The PDF layouts' actions, 1:1 over the PDF mode (PBM). `configuration()` reads the mode's
 * public `pdfConfiguration` getter, never its setter.
 */
export interface PdfActions {
  /** `documents.list()`: the layouts in try order. */
  list(): BuilderDocument[];
  layouts(): PdfLayoutDocument[];
  defaultLayoutId(): string | undefined;
  configuration(): PdfConfiguration;
  newLayout(options: NewPdfLayoutOptions): PdfLayoutDocument;
  addLayout(layout: PdfLayoutDocument): void;
  addTemplate(source: PdfTemplateSource, name: string): PdfTemplateLayout;
  rename(id: string, name: string): void;
  duplicate(id: string, options?: Parameters<PdfBuilderMode["duplicateLayout"]>[1]): PdfLayoutDocument;
  setDefault(id: string): void;
  move(id: string, toIndex: number): void;
  remove(id: string): void;
  /** PBM `applyCatalogForAgent`. */
  applyCatalog(next: PdfConfiguration, subjectId: string): void;
  openState(): PdfOpenState;
  /** The open layout's designer up and a template's PDF read, within the budget. */
  whenOpenReady(timeoutMs: number): Promise<"ready" | "loading" | "failed">;
  /** `{ batch: true, around }` lands every mapping as one layout step. */
  suggestMappings(options: SuggestMappingsOptions): number;
  createFormFields(options: CreateFormFieldsOptions): Promise<CreateFormFieldsResult>;
  previewReport(options: PdfPreviewReportOptions): Promise<PdfPreviewReport | { error: string; busy?: true }>;
  /** The open layout's controller (one per layout). */
  layoutController(): BuilderController | undefined;
}

/** The builder catalogue's view of its element (or of a bare controller). */
export interface BuilderToolHost {
  /** The element's id attribute at registration ("" when none). Input only; the handle is the registrar's. */
  id: string;
  /** False after the element left the page (or its `agent` feature went). */
  connected(): boolean;
  /** The form's controller (never a designer mode's); undefined until the shell is built. */
  controller(): BuilderController | undefined;
  /** The shell is built and the definition applied (no held init); a bare controller is always ready. */
  ready(): boolean;
  /** The composed definition a host would save. */
  definition(): FormDefinition;
  /** Built-ins plus the plugin signatures: for kernelParseFormula / kernelParseFormTests. */
  signatures(): readonly FormulaFunctionSignature[];
  /** The wired plugin functions source (shell.formulaFunctions; WRAP wires host + plugins). The tests runner takes its functions and signatures. */
  formulaFunctions?(): FormulaFunctionsSource | undefined;
  dataSources?(): DataSourceSet | undefined;
  featureOn(feature: BuilderFeature): boolean;
  /** WRAP passes `definitionLoadProblem`; absent: `structureProblemOf` (structure.ts). */
  definitionProblem?(definition: FormDefinition): string | undefined;
  /** WRAP passes `formDefinitionProblem`; absent under a bare controller, so check_form lists that check as skipped. */
  formDefinitionProblem?(definition: FormDefinition): string | undefined;
  /** The tests chunk; only `run_tests` calls it. */
  loadTests(): Promise<TestsChunk>;
  /** The formula editor's module when it is already on the page; never a fetch. */
  formulaEditorLoaded?(): FormulaEditorModule | undefined;
  /**
   * The data-model planner : fetched once per page by `fromData` and
   * `get_definition { section: "data-model" }`; a rejection is `chunk-unavailable { what: "data-model" }`.
   */
  loadDataModelKit?(): Promise<DataModelKit>;
  /** The builder's words (locale and catalog); the catalogue widens them with AGENT_EN. */
  words(): BuilderWords;
  /** Absent under a bare controller. */
  ui?: BuilderToolUi;
  /** Dispatches a datum-agent-* event on the element (the node host records it). */
  emit(type: AgentEventType, detail: unknown): void;
}

/**
 * The session banner's three states; `{ open: false }` without `onUndoAll` or
 * `paused` hides it. A drawn closed banner carries `onDismiss`: the element's
 * Dismiss calls it, so the catalogue lets the banner go and draws it no more.
 */
export type BuilderSessionUi =
  | { open: true; purpose: string; onStop(): void; resumed?: true }
  | { open: false; summary?: string; undoAvailable: number; onUndoAll?(): void; onDismiss?(): void; paused?: true }
  | { stopped: true; undone: number; onAllowAgain(): void };

/** The page around the builder: present only when a person can see it. */
export interface BuilderToolUi {
  workspace(): BuilderWorkspace;
  availableWorkspaces(): BuilderWorkspace[];
  /** WRAP.setWorkspace (a designer's chunk loading is handled there). */
  setWorkspace(id: BuilderWorkspace): boolean;
  /** WRAP.mode */
  mode(): string;
  /** shell.panel */
  panel(): string | undefined;
  /** shell.panelHidden. */
  panelOff(id: string): boolean;
  /**
   * Whether opening this panel would move the workspace on the page (shell.panelWorkspaceTarget),
   * which asks the person's leave guard. Absent: no panel moves it.
   */
  panelMovesWorkspace?(id: string): boolean;
  /** shell.panel = id */
  setPanel(id: string | undefined): void;
  /** shell.trying */
  trying(): boolean;
  /** shell.setTrying: answers whether it ran now. */
  setTrying(on: boolean): boolean;
  /** Whether the person could turn Try it on here: the try-it feature, the form mode and a workspace that has Try it. */
  canTry(): boolean;
  triedAnswers(): Record<string, unknown>;
  clearTriedAnswers(): void;
  dirty(): boolean;
  workspaceProblems(): Partial<Record<BuilderWorkspace, number>>;
  /** WRAP's PDF layout findings under its own gate (`definition.pdf && featureEnabled("pdf")`). */
  pdfFindings?(): PdfLayoutFinding[] | undefined;
  /** Only when the journey diagnostics chunk is already loaded; never a fetch. */
  journeyDiagnostics?(): JourneyDiagnostic[] | undefined;
  /** A designer's document changed (datum-builder-change with detail.mode "pdf" | "journeys"). */
  onOutsideChange(listener: () => void): () => void;
  /** A text control inside the builder has focus: reveal, highlight and the notice's auto-anything are skipped. */
  focusInTextControl(): boolean;
  /** shell.revealComponent */
  revealComponent(id: string): void;
  /** shell.highlightComponents */
  highlight(ids: readonly string[]): void;
  /** The polite live region. */
  announce(text: string): void;
  /** The notice row under a write, with one action (Undo / Redo). */
  notice(text: string, action?: { label: string; run(): void }): void;
  /** Removes the notice row if one shows: the person's own edit dismisses it. */
  clearNotice(): void;
  /** The session banner and `inert` on the shell. */
  setSessionUi(state: BuilderSessionUi): void;

  // ---- all optional ----

  /** SHELL `activeController`: a designer document's controller in Journeys / PDF, else the form's. */
  activeController?(): BuilderController;
  /**
   * SHELL `historyStep(direction, controller)`: one Undo or Redo of `controller`'s own step the
   * way the person's Undo goes, so a journey's Step view keeps its one history over
   * the form and the journey whole (a rename and the journey's follow-up go back together).
   * Absent: the controller's own `undo()` / `redo()`.
   */
  historyStep?(controller: BuilderController, direction: "undo" | "redo"): void;
  /** The installed leave guard's subject id (`"languages-texts"`, `"tests-panel"`, …), whether or not it holds edits. */
  leaveGuardSubject?(): string | undefined;
  /** SHELL `managedSettings`: the property paths the site manages. */
  managedSettings?(): readonly string[];
  /** SHELL `setBindingForAgent`: the View panel's handler (the binding and `builder-binding-change`); false for an unknown id. `undefined` is the default look. */
  setBinding?(id: string | undefined): boolean;
  /** SHELL `setPreviewLocale`: the bar's `locale-change` path, so the switcher and Languages follow. */
  setPreviewLocale?(code: string): void;
  /** SHELL `agentLanguageInputs`: what the Languages surface draws its rows from beyond the controller. */
  languageInputs?(): BuilderAgentLanguageInputs;
  /** SHELL `agentLanguagesPending`: the Languages surface's typed cells, 0 without it. */
  languagesPending?(): number;
  /** Try it's adapter; undefined where the page has no canvas. */
  tryIt?(): TryItAdapter | undefined;
  journeys?(): DesignerSide<JourneyActions>;
  pdfLayouts?(): DesignerSide<PdfActions>;
  /** `SHELL.selectDocument(side, id)` and the wait for the document to open (10 s); never `selectJourney` / `selectLayout`. */
  selectDocument?(side: "journeys" | "pdf", id: string): Promise<SelectDocumentOutcome>;
  /** The site's fillable PDF templates (`wrapper.pdfTemplates.list()`, 5 s). */
  pdfTemplates?(): Promise<PdfTemplateOption[]>;
  /** WRAP `agentTriedRuntime()`: the answers typed in Try it, for a PDF preview. */
  triedRuntimeForPdf?(): PdfPreviewRuntime | undefined;
  /** WRAP `agentSampleRuntime()`: the host's sample answers, for a PDF preview. */
  hostRuntimeForPdf?(): PdfPreviewRuntime;
  /** SHELL `saveAvailable`: the site's Save, when it gave the builder one. */
  saveAvailable?(): { label: string } | undefined;
  /** SHELL `requestSave`: the person's Save without the prompt (`held` instead of `requestLeave`). */
  save?(): Promise<BuilderSaveOutcome>;
}

/** One call the node host recorded. */
export interface RecordedBuilderHostCall {
  method: string;
  args: unknown[];
}

/** The extras a node test hands {@link createControllerHost}. */
export type ControllerHostExtras = Partial<Omit<BuilderToolHost, "ui" | "featureOn">> & {
  /** Per-feature switches; every feature not named is on. */
  featureOn?: Partial<Record<BuilderFeature, boolean>>;
  /** Present: a page is simulated, every member not given a recording no-op. */
  ui?: Partial<BuilderToolUi>;
};

/** The shell's lazy-chunk loaders, as the module instances the shell itself uses, with the data-model planner's. */
export function shellLoaders(): Required<Pick<BuilderToolHost, "loadTests" | "formulaEditorLoaded" | "loadDataModelKit">> {
  return {
    loadTests: () => loadTestsPanel(),
    formulaEditorLoaded: () => formulaEditorLoaded(),
    loadDataModelKit: () => loadDataModelPlan()
  };
}

/** The definition a bare controller stands for: identity, the tree, the languages and the tests. */
function composedDefinition(controller: BuilderController): FormDefinition {
  const identity = controller.identity();
  const definition: FormDefinition = {
    id: identity?.id ?? "form",
    version: identity?.version ?? "1.0.0",
    schemaVersion: identity?.schemaVersion ?? "1",
    root: controller.snapshot()
  };
  const localization = controller.localization();
  if (localization !== undefined) {
    definition.localization = localization;
  }
  const tests = controller.tests();
  if (tests !== undefined) {
    definition.tests = tests;
  }
  return definition;
}

/**
 * The node test host over a bare controller: no page unless `extras.ui`
 * is given, every feature on unless `extras.featureOn` says otherwise, the shell's loaders,
 * and every `emit` (and every call of a simulated `ui` member not given) recorded in `calls`.
 */
export function createControllerHost(
  controller: BuilderController,
  extras: ControllerHostExtras = {}
): BuilderToolHost & { calls: RecordedBuilderHostCall[] } {
  const calls: RecordedBuilderHostCall[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  const { featureOn: switches, ui: uiExtras, ...rest } = extras;
  const loaders = shellLoaders();
  const host: BuilderToolHost & { calls: RecordedBuilderHostCall[] } = {
    id: "",
    connected: () => true,
    controller: () => controller,
    ready: () => true,
    definition: () => composedDefinition(controller),
    signatures: () => formulaFunctionSignatures(),
    loadTests: loaders.loadTests,
    formulaEditorLoaded: loaders.formulaEditorLoaded,
    loadDataModelKit: loaders.loadDataModelKit,
    words: () => new BuilderWords(),
    emit: (type, detail) => record("emit", [type, detail]),
    ...rest,
    featureOn: (feature) => switches?.[feature] ?? true,
    calls
  };
  if (uiExtras !== undefined) {
    host.ui = recordingUi(uiExtras, record, controller);
  }
  return host;
}

/**
 * A simulated page: the members given, every other one a recording no-op answering the bare
 * defaults. The members of the page seams default too: the active controller
 * is the form's, no leave guard, no managed paths, no Try it adapter, both designers `off`, no
 * templates, no Save; the seams that act record their call.
 */
function recordingUi(given: Partial<BuilderToolUi>, record: (method: string, args: unknown[]) => void, controller: BuilderController): BuilderToolUi {
  const noop =
    <R>(method: string, answer: R) =>
    (...args: unknown[]): R => {
      record(`ui.${method}`, args);
      return answer;
    };
  const defaults: BuilderToolUi = {
    workspace: () => "form",
    availableWorkspaces: () => ["form"],
    setWorkspace: noop("setWorkspace", true),
    mode: () => "form",
    panel: () => undefined,
    panelOff: () => false,
    setPanel: noop("setPanel", undefined),
    trying: () => false,
    setTrying: noop("setTrying", true),
    canTry: () => true,
    triedAnswers: () => ({}),
    clearTriedAnswers: noop("clearTriedAnswers", undefined),
    dirty: () => false,
    workspaceProblems: () => ({}),
    onOutsideChange: () => () => undefined,
    focusInTextControl: () => false,
    revealComponent: noop("revealComponent", undefined),
    highlight: noop("highlight", undefined),
    announce: noop("announce", undefined),
    notice: noop("notice", undefined),
    clearNotice: noop("clearNotice", undefined),
    setSessionUi: noop("setSessionUi", undefined),
    activeController: () => controller,
    leaveGuardSubject: () => undefined,
    managedSettings: () => [],
    setBinding: noop("setBinding", false),
    setPreviewLocale: noop("setPreviewLocale", undefined),
    languageInputs: () => ({ chrome: [], extraTexts: [], pdfTexts: [], notLoaded: [] }),
    languagesPending: () => 0,
    tryIt: () => undefined,
    journeys: () => ({ state: "off" }),
    pdfLayouts: () => ({ state: "off" }),
    selectDocument: (...args: unknown[]) => {
      record("ui.selectDocument", args);
      return Promise.resolve({ status: "failed", message: "This page has no designer." });
    },
    pdfTemplates: () => Promise.resolve([]),
    triedRuntimeForPdf: () => undefined,
    saveAvailable: () => undefined,
    save: () => {
      record("ui.save", []);
      return Promise.resolve({ status: "no-save" });
    }
  };
  return { ...defaults, ...given };
}
