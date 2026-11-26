/**
 * The `documents` and `remove_part` bodies' test page: the
 * adapters fixture extended, never edited. `documentsBuilder()` registers the contact-request
 * builder over a `uiStub` and points the page's seams at the fake designers, live (each
 * `ui.journeys()` / `ui.pdfLayouts()` reads the fake's state at call time, so a test can turn a
 * designer `loading` or `off` after registration), with the fake document waiter and the site's
 * templates. `journeySide()` / `pdfSide()` are the element host's adapters over a real mode,
 * one call each, as `packages/datum/src/builder/agent-host.ts` builds them.
 */
import type { BuilderToolUi, DesignerSide, JourneyActions, PdfActions } from "../../form-engine/agent/builder/host.js";
import { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import type { JourneyBuilderMode } from "../../form-engine/builder/journey-designer/journey-builder-mode.js";
import type { PdfBuilderMode } from "../../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { JourneyConfiguration } from "../../form-engine/core/schema/journey.js";
import type { PdfConfiguration } from "../../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../../form-engine/core/schema/types.js";
import { fakePage, type FakePage, type FakeTryItState } from "./agent-builder-adapters.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, uiStub, type AgentBuilder, type AgentBuilderOptions, type UiStub, type UiStubState } from "./agent-builder.js";

export interface DocumentsBuilder {
  builder: AgentBuilder;
  stub: UiStub;
  page: FakePage;
  /** The host's page seam (`builder.host.ui`): assign a member to change what the tools reach. */
  ui: BuilderToolUi;
}

export interface DocumentsBuilderOptions {
  stub?: Partial<UiStubState>;
  /** The fake Try it adapter's state; false (the default): no adapter. */
  tryIt?: Partial<FakeTryItState> | false;
  journeys?: JourneyConfiguration;
  pdf?: PdfConfiguration;
  featureOn?: AgentBuilderOptions["featureOn"];
  host?: AgentBuilderOptions["host"];
  root?: ComponentNode;
  controller?: BuilderController;
}

/** The contact-request builder with both fake designers ready, the document waiter and the templates. */
export function documentsBuilder(options: DocumentsBuilderOptions = {}): DocumentsBuilder {
  const stub = uiStub(options.stub ?? {});
  const builder = agentBuilder({
    ui: stub,
    ...(options.featureOn !== undefined ? { featureOn: options.featureOn } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.controller !== undefined ? { controller: options.controller } : {})
  });
  const page = fakePage(builder.controller, {
    tryIt: options.tryIt ?? false,
    ...(options.journeys !== undefined ? { journeys: options.journeys } : {}),
    ...(options.pdf !== undefined ? { pdf: options.pdf } : {})
  });
  const ui = builder.host.ui as BuilderToolUi;
  ui.journeys = () => page.journeys.side();
  ui.pdfLayouts = () => page.pdf.side();
  ui.selectDocument = page.ui.selectDocument as NonNullable<BuilderToolUi["selectDocument"]>;
  ui.pdfTemplates = page.ui.pdfTemplates as NonNullable<BuilderToolUi["pdfTemplates"]>;
  if (page.tryIt !== undefined) {
    const adapter = page.tryIt.adapter;
    ui.tryIt = () => adapter;
  }
  return { builder, stub, page, ui };
}

/** A designer document's controller (a journey's or a layout's), holding one field `title`. */
export function documentController(): BuilderController {
  const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "title", type: "text", configuration: { label: "Title" } }] } };
  return new BuilderController({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
}

/** `ui.journeys()` over a real Journeys mode: each member one call on it, as the element host's adapter. */
export function journeySide(mode: JourneyBuilderMode): DesignerSide<JourneyActions> {
  const actions: JourneyActions = {
    list: () => mode.documents?.list() ?? [],
    opensAs: () => mode.opensAs,
    journeys: () => mode.journeys,
    configuration: () => mode.journeyConfiguration,
    newJourney: (options) => mode.newJourney(options),
    addJourney: (journey) => mode.addJourney(journey),
    rename: (id, name) => mode.renameJourney(id, name),
    duplicate: (id, options) => mode.duplicateJourney(id, options),
    chooseOpensAs: (id) => mode.chooseOpensAs(id),
    remove: (id) => mode.removeJourney(id),
    applyCatalog: (next, subjectId) => mode.applyCatalogForAgent(next, subjectId)
  };
  return { state: "ready", workspace: () => "journeys", openId: () => mode.journeyId, controller: () => (mode.ready ? mode.controller : undefined), actions };
}

/** `ui.pdfLayouts()` over a real PDF mode: each member one call on it, as the element host's adapter. */
export function pdfSide(mode: PdfBuilderMode): DesignerSide<PdfActions> {
  const actions: PdfActions = {
    list: () => mode.documents?.list() ?? [],
    layouts: () => mode.layouts,
    defaultLayoutId: () => mode.pdfConfiguration.defaultLayoutId,
    configuration: () => mode.pdfConfiguration,
    newLayout: (options) => mode.newLayout(options),
    addLayout: (layout) => mode.addLayout(layout),
    addTemplate: (source, name) => mode.addTemplateLayout(source, name),
    rename: (id, name) => mode.renameLayout(id, name),
    duplicate: (id, options) => mode.duplicateLayout(id, options),
    setDefault: (id) => mode.setDefaultLayout(id),
    move: (id, toIndex) => mode.moveLayout(id, toIndex),
    remove: (id) => mode.removeLayout(id),
    applyCatalog: (next, subjectId) => mode.applyCatalogForAgent(next, subjectId),
    openState: () => mode.openState(),
    whenOpenReady: (timeoutMs) => mode.whenOpenReady(timeoutMs),
    suggestMappings: (options) => mode.suggestMappings(options),
    createFormFields: (options) => mode.createFormFields(options),
    previewReport: (options) => mode.previewReport(options),
    layoutController: () => (mode.ready ? mode.controller : undefined)
  };
  return { state: "ready", workspace: () => "pdf", openId: () => mode.openState().id, controller: () => (mode.ready ? mode.controller : undefined), actions };
}

/** A promise the test resolves: what an async mode call waits on, so the test can act during the await. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
