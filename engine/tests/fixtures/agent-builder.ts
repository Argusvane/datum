/**
 * The builder catalogue's test recipe: the `contact-request` form (Full name, Email, Topic, a Details group holding
 * Message, whose `requiredWhen` reads Topic, and Email me updates, then the untouched seeded
 * Submit) with one test, a controller over the fixture's component types, the node host over it,
 * the real page registrar, and a `ui` stub that records every call and keeps the state it is
 * told (workspace, panel, Try it, mode) so `open` and the visibility rules can be read back.
 *
 * The stub also carries the page's new seams (the active
 * controller, the leave guard's subject, managed paths, the preview theme and language, the
 * Languages inputs, the Try it adapter, both designers, the document waiter, the templates and
 * the Save) as state the test sets; `fixtures/agent-builder-adapters.ts` builds the adapters.
 */
import { createAgentRegistrar, type AgentRegistrar, type AgentRegistrarOptions, type BuilderRegistration } from "../../form-engine/agent/registrar.js";
import { createBuilderTools, type BuilderCatalogue } from "../../form-engine/agent/builder/tools.js";
import { createControllerHost, type BuilderSessionUi, type BuilderToolHost, type BuilderToolUi, type ControllerHostExtras, type RecordedBuilderHostCall } from "../../form-engine/agent/builder/host.js";
import type { AgentRefusal, AgentToolResult } from "../../form-engine/agent/tool-types.js";
import { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import type { BuilderAgentLanguageInputs, BuilderSaveOutcome, BuilderWorkspace } from "../../form-engine/builder/web-component/default-builder-element.js";
import type { DesignerSide, JourneyActions, PdfActions, PdfTemplateOption, SelectDocumentOutcome, TryItAdapter } from "../../form-engine/agent/builder/host.js";
import type { FormTestConfiguration } from "../../form-engine/core/form-tests/form-test-types.js";
import type { ComponentNode } from "../../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DATA_SOURCE_IDS, AGENT_BUILDER_DEFINITIONS, AGENT_BUILDER_LOCALES, AGENT_BUILDER_PALETTE } from "./agent-builder-definitions.js";

export { AGENT_BUILDER_DEFINITIONS, AGENT_BUILDER_PALETTE };

/** The one test of the fixture. */
export const CONTACT_REQUEST_TESTS: FormTestConfiguration = {
  scenarios: [{ id: "test-1", source: 'test "Other topic needs a message"\n  set topic = "other"\n  expect message required\n' }]
};

/** The `contact-request` root: a fresh copy each call. */
export function contactRequestRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Contact request" },
    children: {
      content: [
        { id: "full_name", type: "text", configuration: { label: "Full name", required: true } },
        { id: "email", type: "text", configuration: { label: "Email", required: true } },
        {
          id: "topic",
          type: "select",
          configuration: {
            label: "Topic",
            options: [
              { value: "sales", label: "Sales" },
              { value: "support", label: "Support" },
              { value: "other", label: "Other" }
            ]
          }
        },
        {
          id: "details",
          type: "fieldset",
          configuration: { label: "Details" },
          children: {
            content: [
              { id: "message", type: "textarea", configuration: { label: "Message", rows: 4 }, rules: { requiredWhen: 'topic = "other"' } },
              { id: "subscribe", type: "checkbox", configuration: { label: "Email me updates" } }
            ]
          }
        },
        { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } }
      ]
    }
  };
}

/** A controller over the fixture's types holding `root` (default: contact-request), its identity, languages, data source and tests. */
export function contactRequestController(options: { root?: ComponentNode; tests?: FormTestConfiguration | null } = {}): BuilderController {
  const controller = new BuilderController({
    initialRoot: options.root ?? contactRequestRoot(),
    componentDefinitions: AGENT_BUILDER_DEFINITIONS,
    componentTypes: AGENT_BUILDER_PALETTE,
    identity: { id: "contact-request", version: "1.0.0", schemaVersion: "1" },
    localization: structuredClone(AGENT_BUILDER_LOCALES),
    availableBindings: [{ id: "gcds", label: "GC Design System" }],
    dataSourceIds: [...AGENT_BUILDER_DATA_SOURCE_IDS]
  });
  const tests = options.tests === undefined ? CONTACT_REQUEST_TESTS : options.tests;
  if (tests !== null) {
    controller.setTests(structuredClone(tests), { silent: true });
  }
  return controller;
}

/** The state a {@link uiStub} keeps and the tests set. */
export interface UiStubState {
  workspace: BuilderWorkspace;
  available: BuilderWorkspace[];
  mode: string;
  panel: string | undefined;
  /** Panels left off (`panelOff` answers true). */
  panelsOff: Set<string>;
  trying: boolean;
  canTry: boolean;
  /** What `setTrying` answers (false: the shell refused). */
  setTryingAnswers: boolean;
  /** What `setWorkspace` answers. */
  setWorkspaceAnswers: boolean;
  triedAnswers: Record<string, unknown>;
  dirty: boolean;
  focusInTextControl: boolean;
  /** The banner as last drawn. */
  session: BuilderSessionUi | undefined;
  outsideListeners: Set<() => void>;
  // ---- the page's seams ----
  /** The form's controller (`agentBuilder` sets it); what `activeController` answers unless `activeController` is set. */
  formController: BuilderController | undefined;
  /** A designer document's controller while one is active. */
  activeController: BuilderController | undefined;
  leaveGuardSubject: string | undefined;
  managed: string[];
  /** The binding `setBinding` last set, and what it answers. */
  binding: string | undefined;
  bindingAnswers: boolean;
  previewLocale: string | undefined;
  languageInputs: BuilderAgentLanguageInputs;
  languagesPending: number;
  tryIt: TryItAdapter | undefined;
  journeys: DesignerSide<JourneyActions>;
  pdf: DesignerSide<PdfActions>;
  selectDocument: SelectDocumentOutcome;
  templates: PdfTemplateOption[];
  /** The site's Save label; undefined: no Save. */
  saveLabel: string | undefined;
  saveOutcome: BuilderSaveOutcome;
}

export interface UiStub {
  ui: BuilderToolUi;
  state: UiStubState;
  calls: RecordedBuilderHostCall[];
  /** The calls of one method. */
  callsOf(method: keyof BuilderToolUi): unknown[][];
}

/** A page around the builder that records every call and keeps its state. */
export function uiStub(initial: Partial<UiStubState> = {}): UiStub {
  const state: UiStubState = {
    workspace: "form",
    available: ["form", "logic", "data", "languages"],
    mode: "form",
    panel: "components",
    panelsOff: new Set(),
    trying: false,
    canTry: true,
    setTryingAnswers: true,
    setWorkspaceAnswers: true,
    triedAnswers: {},
    dirty: false,
    focusInTextControl: false,
    session: undefined,
    outsideListeners: new Set(),
    formController: undefined,
    activeController: undefined,
    leaveGuardSubject: undefined,
    managed: [],
    binding: undefined,
    bindingAnswers: true,
    previewLocale: undefined,
    languageInputs: { extraTexts: [], pdfTexts: [], notLoaded: [] },
    languagesPending: 0,
    tryIt: undefined,
    journeys: { state: "off" },
    pdf: { state: "off" },
    selectDocument: { status: "opened" },
    templates: [],
    saveLabel: undefined,
    saveOutcome: { status: "no-save" },
    ...initial
  };
  const calls: RecordedBuilderHostCall[] = [];
  const record = <R>(method: string, args: unknown[], answer: R): R => {
    calls.push({ method, args });
    return answer;
  };
  const ui: BuilderToolUi = {
    workspace: () => record("workspace", [], state.workspace),
    availableWorkspaces: () => record("availableWorkspaces", [], [...state.available]),
    setWorkspace: (id) => {
      record("setWorkspace", [id], undefined);
      if (state.setWorkspaceAnswers) {
        state.workspace = id;
        if (state.trying) {
          state.trying = false;
        }
      }
      return state.setWorkspaceAnswers;
    },
    mode: () => record("mode", [], state.mode),
    panel: () => record("panel", [], state.panel),
    panelOff: (id) => record("panelOff", [id], state.panelsOff.has(id)),
    setPanel: (id) => {
      record("setPanel", [id], undefined);
      state.panel = id;
    },
    trying: () => record("trying", [], state.trying),
    setTrying: (on) => {
      record("setTrying", [on], undefined);
      if (on && !state.setTryingAnswers) {
        return false;
      }
      state.trying = on;
      return true;
    },
    canTry: () => record("canTry", [], state.canTry),
    triedAnswers: () => record("triedAnswers", [], { ...state.triedAnswers }),
    clearTriedAnswers: () => {
      record("clearTriedAnswers", [], undefined);
      state.triedAnswers = {};
    },
    dirty: () => record("dirty", [], state.dirty),
    workspaceProblems: () => record("workspaceProblems", [], {}),
    onOutsideChange: (listener) => {
      record("onOutsideChange", [], undefined);
      state.outsideListeners.add(listener);
      return () => state.outsideListeners.delete(listener);
    },
    focusInTextControl: () => record("focusInTextControl", [], state.focusInTextControl),
    revealComponent: (id) => record("revealComponent", [id], undefined),
    highlight: (ids) => record("highlight", [[...ids]], undefined),
    announce: (text) => record("announce", [text], undefined),
    notice: (text, action) => record("notice", [text, action], undefined),
    clearNotice: () => record("clearNotice", [], undefined),
    setSessionUi: (next) => {
      record("setSessionUi", [next], undefined);
      state.session = next;
    },
    activeController: () => (state.activeController ?? state.formController) as BuilderController,
    leaveGuardSubject: () => state.leaveGuardSubject,
    managedSettings: () => [...state.managed],
    setBinding: (id) => {
      record("setBinding", [id], undefined);
      if (state.bindingAnswers) {
        state.binding = id;
      }
      return state.bindingAnswers;
    },
    setPreviewLocale: (code) => {
      record("setPreviewLocale", [code], undefined);
      state.previewLocale = code;
    },
    languageInputs: () => structuredClone(state.languageInputs),
    languagesPending: () => state.languagesPending,
    tryIt: () => state.tryIt,
    journeys: () => state.journeys,
    pdfLayouts: () => state.pdf,
    selectDocument: (side, id) => record("selectDocument", [side, id], Promise.resolve(structuredClone(state.selectDocument))),
    pdfTemplates: () => Promise.resolve(structuredClone(state.templates)),
    saveAvailable: () => (state.saveLabel === undefined ? undefined : { label: state.saveLabel }),
    save: () => record("save", [], Promise.resolve(structuredClone(state.saveOutcome)))
  };
  return { ui, state, calls, callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.args) };
}

export interface AgentBuilderOptions {
  /** The element's id attribute (the handle when free). */
  id?: string;
  root?: ComponentNode;
  /** `null`: no tests block. */
  tests?: FormTestConfiguration | null;
  /** A page around the builder; absent: a bare controller. */
  ui?: UiStub | Partial<BuilderToolUi>;
  featureOn?: ControllerHostExtras["featureOn"];
  /** Further host members (definitionProblem, formulaEditorLoaded, loadTests, ...). */
  host?: Omit<ControllerHostExtras, "featureOn" | "ui">;
  registrar?: AgentRegistrar;
  registrarOptions?: AgentRegistrarOptions;
  controller?: BuilderController;
}

export interface AgentBuilder {
  controller: BuilderController;
  host: BuilderToolHost & { calls: RecordedBuilderHostCall[] };
  catalogue: BuilderCatalogue;
  registrar: AgentRegistrar;
  registration: BuilderRegistration;
  /** The registration's signal: abort it to unregister. */
  connection: AbortController;
  /** The `ui` stub when one was given as a {@link UiStub}. */
  stub: UiStub | undefined;
  execute(name: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<AgentToolResult>;
}

/** A builder registered on a real registrar. */
export function agentBuilder(options: AgentBuilderOptions = {}): AgentBuilder {
  const controller = options.controller ?? contactRequestController({ ...(options.root !== undefined ? { root: options.root } : {}), ...(options.tests !== undefined ? { tests: options.tests } : {}) });
  const stub = options.ui !== undefined && "state" in options.ui && "calls" in options.ui ? (options.ui as UiStub) : undefined;
  if (stub !== undefined && stub.state.formController === undefined) {
    stub.state.formController = controller;
  }
  const extras: ControllerHostExtras = { ...(options.host ?? {}) };
  if (options.id !== undefined) {
    extras.id = options.id;
  }
  if (options.featureOn !== undefined) {
    extras.featureOn = options.featureOn;
  }
  if (options.ui !== undefined) {
    extras.ui = stub !== undefined ? stub.ui : (options.ui as Partial<BuilderToolUi>);
  }
  const host = createControllerHost(controller, extras);
  const registrar = options.registrar ?? createAgentRegistrar(options.registrarOptions);
  const connection = new AbortController();
  let catalogue: BuilderCatalogue | undefined;
  const registration = registrar.registerBuilder<BuilderToolHost>({
    host,
    catalogue: (given) => {
      catalogue = createBuilderTools(given);
      return catalogue;
    },
    signal: connection.signal,
    id: host.id
  });
  return {
    controller,
    host,
    catalogue: catalogue as unknown as BuilderCatalogue,
    registrar,
    registration,
    connection,
    stub,
    execute: (name, input = {}, executeOptions) => registrar.execute(name, input, executeOptions)
  };
}

/** The result as an ok one (the test fails with the refusal when it is not). */
export function okOf<T = Record<string, unknown>>(result: AgentToolResult): T & Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result as unknown as T & Record<string, unknown>;
}

/** The result as a refusal (the test fails when it is ok). */
export function refusalOf(result: AgentToolResult): AgentRefusal {
  if (result.ok) {
    throw new Error(`expected a refusal, got ok from ${result.tool}`);
  }
  return result;
}
