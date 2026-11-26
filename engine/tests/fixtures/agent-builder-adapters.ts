/**
 * Fakes of the builder page's seams: a Try it adapter over a real `BuilderPreviewRuntime`, the journeys' and the
 * PDF layouts' actions as in-memory catalogs that record every call, the document waiter, the
 * site's templates, the Languages inputs and the shell's Save. Each fake keeps a plain `state`
 * the test sets and reads, and a `calls` list.
 *
 * Written to be extended, never edited, by the per-area
 * `fixtures/agent-builder-<area>-fakes.ts`: build on the factories and their state, or wrap
 * an adapter's members. The catalogs follow the modes' semantics where the tools depend on them
 * (a PDF move writes the default down when none is declared, layout-catalog.ts; `chooseOpensAs`
 * sets the default journey and `opensAs` together, JBM), and nothing else.
 */
import type { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import type { BuilderSaveOutcome, BuilderAgentLanguageInputs } from "../../form-engine/builder/web-component/default-builder-element.js";
import type { BuilderDocument } from "../../form-engine/builder/web-component/builder-modes.js";
import type { TryCheckOutcome, TrySubmitOutcome } from "../../form-engine/builder/web-component/try-it-types.js";
import type { CreateFormFieldsResult, PdfOpenState, PdfPreviewReport } from "../../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import { BuilderPreviewRuntime } from "../../form-engine/builder/preview/builder-preview-runtime.js";
import type { LocalizedText } from "../../form-engine/core/schema/contracts.js";
import type { Journey, JourneyConfiguration } from "../../form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfLayoutDocument, PdfTemplateLayout, PdfTemplateSource } from "../../form-engine/core/schema/pdf-layout.js";
import type {
  BuilderToolUi,
  DesignerAdapter,
  DesignerSide,
  JourneyActions,
  PdfActions,
  PdfTemplateOption,
  SelectDocumentOutcome,
  TryItAdapter
} from "../../form-engine/agent/builder/host.js";
import { AGENT_BUILDER_JOURNEYS, AGENT_BUILDER_PDF, AGENT_BUILDER_TEMPLATES } from "./agent-builder-definitions.js";

/** One recorded call. */
export interface FakeCall {
  method: string;
  args: unknown[];
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function nameText(name: LocalizedText | undefined, id: string): string {
  if (typeof name === "string") {
    return name === "" ? id : name;
  }
  return name?.default ?? id;
}

// ---- Try it --------------------------------------------------------------------------------

/** What the fake Try it adapter answers; the test sets it. */
export interface FakeTryItState {
  trying: boolean;
  tryable: boolean;
  /** What `start()` answers (false: the shell held it). */
  startAnswers: boolean;
  recording: boolean;
  showing: boolean;
  serverChecks: "off" | "on";
  chunk: "ready" | "loading" | "failed" | "off";
  where: { workspace: "form" | "journeys" | "pdf"; journeyId?: string };
  /** The caret control the person types in, if any. */
  focusedPath: string | undefined;
  /** What `check()` resolves with; an Error rejects. */
  checkOutcome: TryCheckOutcome | Error;
  /** What `submit()` resolves with; an Error rejects. */
  submitOutcome: TrySubmitOutcome | { state: "busy" } | Error;
  /** Page node id → the journey's own page id (a journey's Try it); empty for a plain form. */
  pages: Map<string, string>;
}

export interface FakeTryIt {
  adapter: TryItAdapter;
  state: FakeTryItState;
  /** The tried runtime: a real preview over the controller's committed tree when the fake was made. */
  runtime: BuilderPreviewRuntime;
  calls: FakeCall[];
  /** How many quiet page-focus releases are still held. */
  quiet(): number;
  /** Fires `builder-try-submit` to every `onSubmit` listener (anyone's Submit). */
  emitSubmit(outcome: TrySubmitOutcome): void;
}

/** A Try it adapter over a real `BuilderPreviewRuntime` built from `controller`'s committed tree. */
export function fakeTryIt(controller: BuilderController, initial: Partial<FakeTryItState> = {}): FakeTryIt {
  const runtime = new BuilderPreviewRuntime(controller.snapshot(), { locale: controller.currentLocale() });
  const state: FakeTryItState = {
    trying: false,
    tryable: true,
    startAnswers: true,
    recording: false,
    showing: false,
    serverChecks: "off",
    chunk: "ready",
    where: { workspace: "form" },
    focusedPath: undefined,
    checkOutcome: { problems: [], server: "off" },
    submitOutcome: { outcome: "accepted", answers: {}, reference: "DT-000001" },
    pages: new Map(),
    ...initial
  };
  const calls: FakeCall[] = [];
  const listeners = new Set<(outcome: TrySubmitOutcome) => void>();
  let held = 0;
  const record = (method: string, args: unknown[] = []): void => {
    calls.push({ method, args });
  };
  const adapter: TryItAdapter = {
    tryable: () => state.tryable,
    trying: () => state.trying,
    start: () => {
      record("start");
      if (!state.startAnswers) {
        return false;
      }
      state.trying = true;
      return true;
    },
    ready: () => {
      record("ready");
      return Promise.resolve();
    },
    runtime: () => (state.trying ? runtime : undefined),
    typed: () => {
      const tried = runtime.state();
      return { values: { ...tried.values }, dirty: new Set(tried.dirty) };
    },
    where: () => ({ ...state.where }),
    pageIdOf: (nodeId) => state.pages.get(nodeId),
    nodeIdOf: (pageId) => [...state.pages].find(([, page]) => page === pageId)?.[0],
    quietPageFocus: () => {
      record("quietPageFocus");
      held += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          held -= 1;
          record("releasePageFocus");
        }
      };
    },
    focusedPath: () => state.focusedPath,
    recording: () => state.recording,
    showing: () => state.showing,
    serverChecks: () => state.serverChecks,
    onSubmit: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => {
      record("check");
      return state.checkOutcome instanceof Error ? Promise.reject(state.checkOutcome) : Promise.resolve(copy(state.checkOutcome));
    },
    submit: () => {
      record("submit");
      const outcome = state.submitOutcome;
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      if (!("state" in outcome)) {
        for (const listener of listeners) {
          listener(copy(outcome));
        }
      }
      return Promise.resolve(copy(outcome));
    },
    clear: () => {
      record("clear");
      runtime.clearValues();
    },
    chunk: () => state.chunk
  };
  return {
    adapter,
    state,
    runtime,
    calls,
    quiet: () => held,
    emitSubmit: (outcome) => {
      for (const listener of listeners) {
        listener(copy(outcome));
      }
    }
  };
}

// ---- the designers ---------------------------------------------------------------------------

/** A designer side's state: ready with its catalog, or not, and which document is open. */
export interface FakeDesignerState {
  state: "ready" | "loading" | "failed" | "off" | "hidden";
  workspace: string;
  openId: string | undefined;
  /** Each document's own controller, when the test gives one (a designer document's drafts). */
  controllers: Map<string, BuilderController>;
}

export interface FakeJourneys {
  actions: JourneyActions;
  designer: FakeDesignerState;
  /** The catalog as the mode holds it (`journeyConfiguration`). */
  configuration: JourneyConfiguration;
  calls: FakeCall[];
  /** `ui.journeys()`. */
  side(): DesignerSide<JourneyActions>;
}

/** The journeys' catalog in memory (JBM's catalog semantics where the tools read them). */
export function fakeJourneys(initial: JourneyConfiguration = AGENT_BUILDER_JOURNEYS): FakeJourneys {
  const calls: FakeCall[] = [];
  const fake: FakeJourneys = {
    configuration: copy(initial),
    designer: { state: "ready", workspace: "journeys", openId: undefined, controllers: new Map() },
    calls,
    actions: undefined as unknown as JourneyActions,
    side: () => (fake.designer.state === "ready" ? adapter : { state: fake.designer.state })
  };
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args: copy(args) });
  };
  const journeys = (): Journey[] => (fake.configuration.journeys ??= []);
  const find = (id: string): Journey => {
    const found = journeys().find((journey) => journey.id === id);
    if (found === undefined) {
      throw new Error(`No journey "${id}".`);
    }
    return found;
  };
  let made = 0;
  const actions: JourneyActions = {
    list: (): BuilderDocument[] => {
      const fallback = fake.configuration.defaultJourneyId ?? journeys()[0]?.id;
      return journeys().map((journey) => ({ id: journey.id, label: nameText(journey.name, journey.id), isDefault: journey.id === fallback }));
    },
    opensAs: () => fake.configuration.opensAs ?? "journey",
    journeys: () => copy(journeys()),
    configuration: () => copy(fake.configuration),
    newJourney: async (options) => {
      record("newJourney", [{ ...options, around: options.around !== undefined }]);
      await Promise.resolve();
      made += 1;
      const journey: Journey = { id: `journey-${made}`, name: options.name ?? `Journey ${made + 1}`, pages: [{ id: "page-1", components: [] }] };
      const step = (): void => {
        journeys().push(journey);
      };
      if (options.around !== undefined) {
        options.around(step);
      } else {
        step();
      }
      return copy(journey);
    },
    addJourney: (journey) => {
      record("addJourney", [journey]);
      journeys().push(copy(journey));
    },
    rename: (id, name) => {
      record("rename", [id, name]);
      find(id).name = name;
    },
    duplicate: (id, options) => {
      record("duplicate", [id, options]);
      const copyOf = copy(find(id));
      copyOf.id = `${id}-copy`;
      copyOf.name = options?.name ?? `${nameText(find(id).name, id)} copy`;
      journeys().push(copyOf);
      return copy(copyOf);
    },
    chooseOpensAs: (id) => {
      record("chooseOpensAs", [id]);
      if (id === "form") {
        fake.configuration.opensAs = "form";
        return;
      }
      fake.configuration.defaultJourneyId = id;
      delete fake.configuration.opensAs;
    },
    remove: (id) => {
      record("remove", [id]);
      fake.configuration.journeys = journeys().filter((journey) => journey.id !== id);
      if (fake.configuration.defaultJourneyId === id) {
        delete fake.configuration.defaultJourneyId;
      }
    },
    applyCatalog: (next, subjectId) => {
      record("applyCatalog", [next, subjectId]);
      fake.configuration = copy(next ?? {});
    }
  };
  const adapter: DesignerAdapter<JourneyActions> = {
    state: "ready",
    workspace: () => fake.designer.workspace,
    openId: () => fake.designer.openId,
    controller: () => (fake.designer.openId !== undefined ? fake.designer.controllers.get(fake.designer.openId) : undefined),
    actions
  };
  fake.actions = actions;
  return fake;
}

export interface FakePdfState {
  /** What `openState()` answers. */
  open: PdfOpenState;
  /** What `whenOpenReady()` resolves with. */
  ready: "ready" | "loading" | "failed";
  /** How many mappings `suggestMappings` makes. */
  mappings: number;
  /** What `createFormFields` resolves with. */
  formFields: CreateFormFieldsResult;
  /** What `previewReport` resolves with. */
  preview: PdfPreviewReport | { error: string; busy?: true };
  /** The open layout's controller (one per layout). */
  layoutController: BuilderController | undefined;
}

export interface FakePdf {
  actions: PdfActions;
  designer: FakeDesignerState;
  /** The catalog as the mode holds it (`pdfConfiguration`). */
  configuration: PdfConfiguration;
  state: FakePdfState;
  calls: FakeCall[];
  /** `ui.pdfLayouts()`. */
  side(): DesignerSide<PdfActions>;
}

/** The PDF layouts' catalog in memory (PBM's catalog semantics where the tools read them). */
export function fakePdf(initial: PdfConfiguration = AGENT_BUILDER_PDF): FakePdf {
  const calls: FakeCall[] = [];
  const fake: FakePdf = {
    configuration: copy(initial),
    designer: { state: "ready", workspace: "pdf", openId: undefined, controllers: new Map() },
    state: {
      open: { ready: false },
      ready: "ready",
      mappings: 0,
      formFields: { added: [], mapped: 0, matched: 0, skipped: [] },
      preview: { layoutId: "summary", layoutChoice: "given", layoutKind: "generated", pageCount: 1, warnings: [] },
      layoutController: undefined
    },
    calls,
    actions: undefined as unknown as PdfActions,
    side: () => (fake.designer.state === "ready" ? adapter : { state: fake.designer.state })
  };
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args: copy(args) });
  };
  const layouts = (): PdfLayoutDocument[] => (fake.configuration.layouts ??= []);
  const find = (id: string): PdfLayoutDocument => {
    const found = layouts().find((layout) => layout.id === id);
    if (found === undefined) {
      throw new Error(`No layout "${id}".`);
    }
    return found;
  };
  let made = 0;
  const actions: PdfActions = {
    list: (): BuilderDocument[] => {
      const fallback = fake.configuration.defaultLayoutId ?? layouts()[0]?.id;
      return layouts().map((layout) => ({ id: layout.id, label: nameText(layout.name, layout.id), isDefault: layout.id === fallback }));
    },
    layouts: () => copy(layouts()),
    defaultLayoutId: () => fake.configuration.defaultLayoutId,
    configuration: () => copy(fake.configuration),
    newLayout: (options) => {
      record("newLayout", [options]);
      if (options.name.trim() === "") {
        throw new Error("A layout needs a name");
      }
      made += 1;
      const layout: PdfLayoutDocument = { id: `layout-${made}`, kind: "generated", name: options.name, root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } };
      layouts().push(layout);
      return copy(layout);
    },
    addLayout: (layout) => {
      record("addLayout", [layout]);
      layouts().push(copy(layout));
    },
    addTemplate: (source: PdfTemplateSource, name: string) => {
      record("addTemplate", [source, name]);
      made += 1;
      const layout: PdfTemplateLayout = { id: `template-${made}`, kind: "template", name: name === "" ? "Paper form" : name, template: copy(source), fields: [] };
      layouts().push(layout);
      return copy(layout);
    },
    rename: (id, name) => {
      record("rename", [id, name]);
      find(id).name = name;
    },
    duplicate: (id, options) => {
      record("duplicate", [id, options]);
      const copyOf = copy(find(id));
      copyOf.id = `${id}-copy`;
      copyOf.name = options?.name ?? `${nameText(find(id).name, id)} copy`;
      layouts().push(copyOf);
      return copy(copyOf);
    },
    setDefault: (id) => {
      record("setDefault", [id]);
      fake.configuration.defaultLayoutId = id;
    },
    move: (id, toIndex) => {
      record("move", [id, toIndex]);
      // movePdfLayout writes the default down first when none is declared (layout-catalog.ts).
      if (fake.configuration.defaultLayoutId === undefined && layouts().length > 0) {
        fake.configuration.defaultLayoutId = (layouts()[0] as PdfLayoutDocument).id;
      }
      const list = layouts();
      const from = list.findIndex((layout) => layout.id === id);
      const [layout] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, layout as PdfLayoutDocument);
    },
    remove: (id) => {
      record("remove", [id]);
      fake.configuration.layouts = layouts().filter((layout) => layout.id !== id);
      if (fake.configuration.defaultLayoutId === id) {
        delete fake.configuration.defaultLayoutId;
      }
    },
    applyCatalog: (next, subjectId) => {
      record("applyCatalog", [next, subjectId]);
      fake.configuration = copy(next);
    },
    openState: () => copy(fake.state.open),
    whenOpenReady: (timeoutMs) => {
      record("whenOpenReady", [timeoutMs]);
      return Promise.resolve(fake.state.ready);
    },
    suggestMappings: (options) => {
      record("suggestMappings", [{ batch: options.batch, around: options.around !== undefined }]);
      const controller = fake.state.layoutController;
      const step = (): void => {
        if (controller !== undefined && fake.state.mappings > 0) {
          controller.setProperties([{ componentId: controller.rootId(), propertyPath: "label", value: `mapped ${fake.state.mappings}` }]);
        }
      };
      if (options.around !== undefined) {
        options.around(step);
      } else {
        step();
      }
      return fake.state.mappings;
    },
    createFormFields: async (options) => {
      record("createFormFields", [{ around: options.around !== undefined }]);
      await Promise.resolve();
      return copy(fake.state.formFields);
    },
    previewReport: (options) => {
      record("previewReport", [{ layoutId: options.layoutId, runtime: options.runtime !== undefined }]);
      return Promise.resolve(copy(fake.state.preview));
    },
    layoutController: () => fake.state.layoutController
  };
  const adapter: DesignerAdapter<PdfActions> = {
    state: "ready",
    workspace: () => fake.designer.workspace,
    openId: () => fake.designer.openId,
    controller: () => fake.state.layoutController ?? (fake.designer.openId !== undefined ? fake.designer.controllers.get(fake.designer.openId) : undefined),
    actions
  };
  fake.actions = actions;
  return fake;
}

// ---- the page seams --------------------------------------------------------------------------

/** The shell's other seams as plain state the test sets. */
export interface FakePageState {
  /** What `selectDocument` answers; it also opens the document on the fake designer when "opened". */
  select: SelectDocumentOutcome;
  /** The site's templates (`pdfTemplates`). */
  templates: PdfTemplateOption[];
  languageInputs: BuilderAgentLanguageInputs;
  languagesPending: number;
  /** The site's Save label; undefined: no Save. */
  saveLabel: string | undefined;
  /** What `save()` resolves with. */
  saveOutcome: BuilderSaveOutcome;
  /** The preview language `setPreviewLocale` last set. */
  previewLocale: string | undefined;
  /** The binding `setBinding` last set, and what it answers. */
  binding: string | undefined;
  bindingAnswers: boolean;
  managed: string[];
}

export interface FakePage {
  /** The members to hand `agentBuilder({ ui })` (with `uiStub`, assign them onto `stub.ui`). */
  ui: Partial<BuilderToolUi>;
  state: FakePageState;
  tryIt: FakeTryIt | undefined;
  journeys: FakeJourneys;
  pdf: FakePdf;
  calls: FakeCall[];
}

/**
 * Every page seam at once over `controller`: Try it (when `tryIt` is not false), both
 * designers ready, the document waiter, the templates, the Languages inputs and the Save.
 */
export function fakePage(controller: BuilderController, options: { tryIt?: Partial<FakeTryItState> | false; journeys?: JourneyConfiguration; pdf?: PdfConfiguration } = {}): FakePage {
  const calls: FakeCall[] = [];
  const tryIt = options.tryIt === false ? undefined : fakeTryIt(controller, options.tryIt ?? {});
  const journeys = fakeJourneys(options.journeys ?? AGENT_BUILDER_JOURNEYS);
  const pdf = fakePdf(options.pdf ?? AGENT_BUILDER_PDF);
  const state: FakePageState = {
    select: { status: "opened" },
    templates: copy(AGENT_BUILDER_TEMPLATES),
    languageInputs: { extraTexts: [], pdfTexts: [], notLoaded: [] },
    languagesPending: 0,
    saveLabel: "Save",
    saveOutcome: { status: "saved", localeChanges: { removed: [], renamed: [] } },
    previewLocale: undefined,
    binding: undefined,
    bindingAnswers: true,
    managed: []
  };
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args: copy(args) });
  };
  const ui: Partial<BuilderToolUi> = {
    managedSettings: () => [...state.managed],
    setBinding: (id) => {
      record("setBinding", [id]);
      if (state.bindingAnswers) {
        state.binding = id;
      }
      return state.bindingAnswers;
    },
    setPreviewLocale: (code) => {
      record("setPreviewLocale", [code]);
      state.previewLocale = code;
    },
    languageInputs: () => copy(state.languageInputs),
    languagesPending: () => state.languagesPending,
    tryIt: () => tryIt?.adapter,
    journeys: () => journeys.side(),
    pdfLayouts: () => pdf.side(),
    selectDocument: (side, id) => {
      record("selectDocument", [side, id]);
      if (state.select.status === "opened") {
        (side === "journeys" ? journeys : pdf).designer.openId = id;
      }
      return Promise.resolve(copy(state.select));
    },
    pdfTemplates: () => Promise.resolve(copy(state.templates)),
    saveAvailable: () => (state.saveLabel === undefined ? undefined : { label: state.saveLabel }),
    save: () => {
      record("save", []);
      return Promise.resolve(copy(state.saveOutcome));
    }
  };
  return { ui, state, tryIt, journeys, pdf, calls };
}
