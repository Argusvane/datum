import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The builder agent's designer adapters against the real modes: `ui.journeys()` and `ui.pdfLayouts()` of the element host are 1:1
 * over `wrapper.journeyMode` / `wrapper.pdfMode`, so every action member reaches the one mode
 * method of its meaning once, with the same arguments, and hands back what the mode answered.
 * The modes are built as the engine's own tests build them (`journey-builder-mode.test.ts`,
 * `pdf-designer.test.ts`) and stand on a wrapper stand-in that answers only what the host reads
 * for the designers: their states, the two modes and the shell's shadow root. `previewReport`
 * renders through a stub provider and reports the facts, the shell's root given for its dialog.
 */

import { elementBuilderHost } from "../src/builder/agent-host.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DesignerAdapter, JourneyActions, PdfActions } from "@argusvane/datum-engine/agent";

import { BuilderController } from "../../../engine/form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../../../engine/form-engine/builder/journey-designer/journey-builder-mode.js";
import { createPdfBuilderMode, type PdfBuilderMode } from "../../../engine/form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { BuilderModeContext } from "../../../engine/form-engine/builder/web-component/builder-modes.js";
import type { JourneyConfiguration } from "../../../engine/form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfGeneratedLayout } from "../../../engine/form-engine/core/schema/pdf-layout.js";
import type { FormState } from "../../../engine/form-engine/core/state/form-state.js";
import type { ComponentNode } from "../../../engine/form-engine/core/schema/types.js";
import { ComponentTree } from "../../../engine/form-engine/core/tree/component-tree.js";
import type { RenderableRuntime } from "../../../engine/form-engine/render/core/runtime-render-bridge.js";
import type { PdfRenderProvider } from "../../../engine/form-engine/render/pdf/pdf-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      { id: "fullName", type: "text", configuration: { label: "Full name" } },
      { id: "email", type: "text", configuration: { label: "Email" } },
      { id: "submit", type: "button", configuration: { label: "Send" } }
    ]
  }
};

function journeySeed(): JourneyConfiguration {
  return {
    journeys: [
      { id: "intake", name: "Intake", pages: [{ id: "about", title: "About you", components: ["fullName"] }, { id: "contact", components: ["email", "submit"] }] },
      { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName", "email", "submit"] }] }
    ],
    defaultJourneyId: "intake"
  } as unknown as JourneyConfiguration;
}

function layout(id: string, name: string): PdfGeneratedLayout {
  return { id, kind: "generated", name, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
}

function pdfSeed(): PdfConfiguration {
  return { layouts: [layout("summary", "Summary"), layout("full", "Full")], defaultLayoutId: "summary" };
}

/** A runtime as the PDF renderers read one: the form and its sample answers. */
function sampleRuntime(): RenderableRuntime {
  const state: FormState = {
    values: { fullName: "Ada" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
  return {
    formRoot: () => FORM,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(FORM),
    resolveDataSource: async () => undefined
  };
}

/** A kernel stand-in: every render is two pages with one warning in kernel words. */
function stubProvider(): PdfRenderProvider {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return {
    id: "fake",
    abiVersion: "4.0.0",
    render: async () => ({ bytes, pageCount: 2, pages: [], warnings: [{ code: "font.fallback_standard14", message: "Helvetica stood in for Kernel Sans", componentId: "fullName" }], providerId: "fake" }),
    fill: async () => ({ bytes, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [] }),
    inspect: async () => ({ pageCount: 1, pages: [], fields: [], hasXfa: false, encrypted: false })
  } as unknown as PdfRenderProvider;
}

/** A shell's shadow root and the context a mode is activated with on it. */
function shellContext(): { host: HTMLElement; root: ShadowRoot; context: BuilderModeContext } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  return { host, root, context: { host, root, showCanvasSurface: () => undefined } };
}

interface Modes {
  form: BuilderController;
  journeyMode: JourneyBuilderMode;
  pdfMode: PdfBuilderMode;
  shellRoot: ShadowRoot;
  journeys: DesignerAdapter<JourneyActions>;
  pdf: DesignerAdapter<PdfActions>;
}

/**
 * Both modes over one form, the PDF one activated on a shell's root (its dialog in it), and the
 * element host's two adapters over them through a wrapper stand-in.
 */
async function modes(seeds: { journey?: JourneyConfiguration; pdf?: PdfConfiguration } = {}): Promise<Modes> {
  const form = new BuilderController({ initialRoot: structuredClone(FORM) });
  const journeyMode = createJourneyBuilderMode({ form, journey: seeds.journey ?? journeySeed() });
  const runtime = sampleRuntime();
  const pdfMode = createPdfBuilderMode({ formRoot: () => structuredClone(FORM), form: () => form, runtime: () => runtime, support: { provider: stubProvider() }, locale: () => "en", pdf: seeds.pdf ?? pdfSeed() });
  const shell = shellContext();
  shell.root.append(...(pdfMode.overlays ?? []));
  await pdfMode.activate!(shell.context);
  const wrapper = {
    id: "",
    shadowRoot: null,
    agentModeState: { journeys: "ready", pdf: "ready" },
    journeyMode,
    pdfMode,
    builder: { shadowRoot: shell.root }
  } as unknown as DatumFormBuilderElement;
  const host = elementBuilderHost(wrapper);
  const journeys = host.ui!.journeys!();
  const pdf = host.ui!.pdfLayouts!();
  if (journeys.state !== "ready" || pdf.state !== "ready") {
    throw new Error("the adapters are not ready");
  }
  return { form, journeyMode, pdfMode, shellRoot: shell.root, journeys, pdf };
}

/** Spies `method` on `target` (its real body runs) and checks the adapter's call reached it once, with the same arguments, answering what it answered. */
async function reaches<T extends object>(target: T, method: keyof T & string, call: () => unknown, args: unknown[]): Promise<void> {
  const spy = vi.spyOn(target as Record<string, (...a: unknown[]) => unknown>, method);
  const answered = await call();
  expect(spy, method).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0], method).toEqual(args);
  const returned = spy.mock.results[0]!.value as unknown;
  expect(answered, method).toEqual(returned instanceof Promise ? await returned : returned);
  spy.mockRestore();
}

describe("the journeys' adapter over the real JourneyBuilderMode", () => {
  it("reads the mode: documents, journeys, opensAs, the configuration getter, the open journey and its controller", async () => {
    const { journeyMode, journeys } = await modes();
    expect(journeys.workspace()).toBe("journeys");
    expect(journeys.actions.list()).toEqual(journeyMode.documents!.list());
    expect(journeys.actions.journeys()).toEqual(journeyMode.journeys);
    expect(journeys.actions.opensAs()).toBe(journeyMode.opensAs);
    expect(journeys.actions.configuration()).toBe(journeyMode.journeyConfiguration);
    expect(journeyMode.journeyId).toBe("intake");
    expect(journeys.openId()).toBe("intake");
    expect(journeys.controller()).toBe(journeyMode.controller);
  });

  it("with no journey open (none to open), the open id and the controller are undefined, never the mode's idle controller", async () => {
    // The page falls back to the default, then the first journey, so only zero journeys leave none open.
    const { journeyMode, journeys } = await modes({ journey: { journeys: [] } as unknown as JourneyConfiguration });
    expect(journeyMode.journeys).toEqual([]);
    expect(journeyMode.journeyId).toBeUndefined();
    // The mode still answers a controller (its idle one); the adapter must not hand it on.
    expect(journeyMode.controller).toBeDefined();
    expect(journeys.openId()).toBeUndefined();
    expect(journeys.controller()).toBeUndefined();
    expect(journeys.controller()).not.toBe(journeyMode.controller);
  });

  it("every action reaches its mode method once, with the same arguments", async () => {
    const { journeyMode, journeys } = await modes();
    const actions = journeys.actions;
    await reaches(journeyMode, "renameJourney", () => actions.rename("quick", "Quick one"), ["quick", "Quick one"]);
    expect(journeyMode.journeys.find((journey) => journey.id === "quick")?.name).toBe("Quick one");
    await reaches(journeyMode, "chooseOpensAs", () => actions.chooseOpensAs("quick"), ["quick"]);
    await reaches(journeyMode, "duplicateJourney", () => actions.duplicate("quick", { name: "Quick copy" }), ["quick", { name: "Quick copy" }]);
    const copy = journeyMode.journeys.find((journey) => journey.name === "Quick copy")!;
    await reaches(journeyMode, "removeJourney", () => actions.remove(copy.id), [copy.id]);
    const added = { id: "extra", name: "Extra", pages: [{ id: "p", components: ["fullName"] }] };
    await reaches(journeyMode, "addJourney", () => actions.addJourney(added as never), [added]);
    const next = structuredClone(journeyMode.journeyConfiguration);
    await reaches(journeyMode, "applyCatalogForAgent", () => actions.applyCatalog(next, "extra"), [next, "extra"]);
    // newJourney loads the designer; its body is the mode's own, stood in here: the call is what is checked.
    const made = { id: "made", name: "Made", pages: [] };
    const around = (step: () => void): void => step();
    const create = vi.spyOn(journeyMode, "newJourney").mockResolvedValue(made as never);
    expect(await actions.newJourney({ from: "one-page", name: "Made", around })).toBe(made);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ from: "one-page", name: "Made", around });
  });
});

describe("the PDF layouts' adapter over the real PdfBuilderMode", () => {
  it("reads the mode: documents, layouts, the declared default, the configuration getter, the open layout and its controller", async () => {
    const { pdfMode, pdf } = await modes();
    expect(pdf.workspace()).toBe("pdf");
    expect(pdf.actions.list()).toEqual(pdfMode.documents!.list());
    expect(pdf.actions.layouts()).toEqual(pdfMode.layouts);
    expect(pdf.actions.defaultLayoutId()).toBe("summary");
    expect(pdf.actions.configuration()).toBe(pdfMode.pdfConfiguration);
    expect(pdf.openId()).toBe(pdfMode.layoutId);
    expect(pdf.openId()).toBeDefined();
    expect(pdf.controller()).toBe(pdfMode.controller);
    expect(pdf.actions.layoutController()).toBe(pdfMode.controller);
    expect(pdf.actions.openState()).toEqual(pdfMode.openState());
  });

  it("with zero layouts the open id, the controller and layoutController are undefined, never the mode's idle controller", async () => {
    const { pdfMode, pdf } = await modes({ pdf: { layouts: [] } as unknown as PdfConfiguration });
    expect(pdfMode.layouts).toEqual([]);
    expect(pdfMode.layoutId).toBeUndefined();
    // The mode still answers a controller (its idle one); the adapter must not hand it on.
    expect(pdfMode.controller).toBeDefined();
    expect(pdf.openId()).toBeUndefined();
    expect(pdf.controller()).toBeUndefined();
    expect(pdf.controller()).not.toBe(pdfMode.controller);
    expect(pdf.actions.layoutController()).toBeUndefined();
    expect(pdf.actions.layoutController()).not.toBe(pdfMode.controller);
  });

  it("every action reaches its mode method once, with the same arguments", async () => {
    const { pdfMode, pdf } = await modes();
    const actions = pdf.actions;
    const around = (step: () => void): void => step();
    await reaches(pdfMode, "renameLayout", () => actions.rename("full", "Everything"), ["full", "Everything"]);
    await reaches(pdfMode, "setDefaultLayout", () => actions.setDefault("full"), ["full"]);
    await reaches(pdfMode, "moveLayout", () => actions.move("full", 0), ["full", 0]);
    await reaches(pdfMode, "duplicateLayout", () => actions.duplicate("summary", { name: "Summary copy", select: false }), ["summary", { name: "Summary copy", select: false }]);
    await reaches(pdfMode, "newLayout", () => actions.newLayout({ name: "Blank one", from: "blank", select: false }), [{ name: "Blank one", from: "blank", select: false }]);
    const added = layout("added", "Added");
    await reaches(pdfMode, "addLayout", () => actions.addLayout(added), [added]);
    await reaches(pdfMode, "removeLayout", () => actions.remove("added"), ["added"]);
    const next = structuredClone(pdfMode.pdfConfiguration);
    await reaches(pdfMode, "applyCatalogForAgent", () => actions.applyCatalog(next, "full"), [next, "full"]);
    await reaches(pdfMode, "whenOpenReady", () => actions.whenOpenReady(50), [50]);
    await reaches(pdfMode, "suggestMappings", () => actions.suggestMappings({ batch: true, around }), [{ batch: true, around }]);
    await reaches(pdfMode, "createFormFields", () => actions.createFormFields({ around }), [{ around }]);
    const source = { storage: "base64", name: "claim.pdf", type: "application/pdf", size: 3, data: "AAA=" } as const;
    const template = vi.spyOn(pdfMode, "addTemplateLayout").mockReturnValue({ id: "paper", kind: "template", name: "Paper", template: source, fields: [] });
    expect(actions.addTemplate(source, "Paper").id).toBe("paper");
    expect(template).toHaveBeenCalledTimes(1);
    expect(template).toHaveBeenCalledWith(source, "Paper");
  });

  it("previewReport returns the render's facts through a stub provider, given the shell's root for its dialog", async () => {
    const { pdfMode, pdf, shellRoot } = await modes();
    const preview = vi.spyOn(pdfMode, "previewReport");
    const report = await pdf.actions.previewReport({ layoutId: "full" });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({ layoutId: "full", root: shellRoot });
    expect(report).toMatchObject({ layoutId: "full", layoutChoice: "given", layoutKind: "generated", pageCount: 2 });
    if ("error" in report) {
      throw new Error(report.error);
    }
    expect(report.warnings).toContainEqual({ code: "font.fallback_standard14", componentId: "fullName" });
    expect(JSON.stringify(report)).not.toContain("Helvetica");
    // A root the caller names is kept as given.
    const other = shellContext().root;
    preview.mockClear();
    await pdf.actions.previewReport({ layoutId: "summary", root: other });
    expect(preview).toHaveBeenCalledWith({ layoutId: "summary", root: other });
  });
});
