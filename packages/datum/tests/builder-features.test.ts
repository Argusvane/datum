import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The builder's `features` list and `hidden-panels`. Every chunk loader the builder
 * has is wrapped to count the requests it gets, so a part the list leaves out can be shown to
 * ask for none of them: at connect, on an edit, on undo, on a repaint, on every way to reach it.
 * Without the attribute the builder is today's, checked against the values it had before.
 */
type Loader = Record<string, (...args: unknown[]) => unknown>;
const { asked, onPage, counting } = vi.hoisted(() => {
  const requests = {
    print: 0,
    pdf: 0,
    journeys: 0,
    chrome: 0,
    variables: 0,
    logic: 0,
    data: 0,
    languages: 0,
    overview: 0,
    palette: 0,
    json: 0,
    tryIt: 0,
    diagnostics: 0
  };
  const wrap =
    (key: keyof typeof requests, names: readonly string[]) =>
    async (importOriginal: () => Promise<Record<string, (...args: unknown[]) => unknown>>) => {
      const actual = await importOriginal();
      const wrapped: Record<string, (...args: unknown[]) => unknown> = { ...actual };
      for (const name of names) {
        wrapped[name] = (...args: unknown[]) => {
          requests[key] += 1;
          return actual[name]!(...args);
        };
      }
      return wrapped;
    };
  return { asked: requests, onPage: { chrome: false, variables: false }, counting: wrap };
});

vi.mock("../../../engine/form-engine/builder/pdf-designer/pdf-mode-loader.ts", async (importOriginal) =>
  counting("pdf", ["loadPdfBuilderMode", "loadedPdfBuilderMode"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/journey-designer/journey-mode-loader.ts", async (importOriginal) =>
  counting("journeys", ["loadJourneyBuilderMode", "loadedJourneyBuilderMode"])(importOriginal as () => Promise<Loader>)
);
// The panels' loaders keep a flag of their own for "on the page", reset before each test, so a chunk
// an earlier test fetched is asked for again (the import itself is cached): every ask is counted.
vi.mock("../../../engine/form-engine/builder/web-component/chrome-panel-loader.ts", async (importOriginal) => {
  const actual = await importOriginal<{ loadChromePanel(): Promise<unknown>; chromePanelLoaded(): unknown }>();
  return {
    ...actual,
    chromePanelLoaded: () => (onPage.chrome ? actual.chromePanelLoaded() : undefined),
    loadChromePanel: async () => {
      asked.chrome += 1;
      const module = await actual.loadChromePanel();
      onPage.chrome = true;
      return module;
    }
  };
});
vi.mock("../../../engine/form-engine/builder/web-component/variables-panel-loader.ts", async (importOriginal) => {
  const actual = await importOriginal<{ loadVariablesPanel(): Promise<unknown>; variablesPanelLoaded(): unknown }>();
  return {
    ...actual,
    variablesPanelLoaded: () => (onPage.variables ? actual.variablesPanelLoaded() : undefined),
    loadVariablesPanel: async () => {
      asked.variables += 1;
      const module = await actual.loadVariablesPanel();
      onPage.variables = true;
      return module;
    }
  };
});
vi.mock("../../../engine/form-engine/builder/logic/logic-loader.ts", async (importOriginal) =>
  counting("logic", ["loadLogicSurface"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/data/data-loader.ts", async (importOriginal) =>
  counting("data", ["loadDataSurface"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/languages/languages-loader.ts", async (importOriginal) =>
  counting("languages", ["loadLanguagesSurface"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/print/print-loader.ts", async (importOriginal) =>
  counting("print", ["loadPrintSurface"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/overview/overview-loader.ts", async (importOriginal) =>
  counting("overview", ["loadOverviewSurface"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/palette/palette-loader.ts", async (importOriginal) =>
  counting("palette", ["loadCommandPalette"])(importOriginal as () => Promise<Loader>)
);
vi.mock("../../../engine/form-engine/builder/web-component/json-viewer-loader.ts", async (importOriginal) =>
  counting("json", ["loadJsonViewer", "mountJsonViewerAfter"])(importOriginal as () => Promise<Loader>)
);
// Try it's chunk is `import("./try-it.js")`, cached by the module system: the canvas making its
// controller from it is the ask, once per canvas.
vi.mock("../../../engine/form-engine/builder/web-component/try-it.ts", async (importOriginal) => {
  const actual = await importOriginal<{ createTryIt(...args: unknown[]): unknown }>();
  return {
    ...actual,
    createTryIt: (...args: unknown[]) => {
      asked.tryIt += 1;
      return actual.createTryIt(...args);
    }
  };
});
vi.mock("../src/journey-debug.js", async (importOriginal) =>
  counting("diagnostics", ["loadJourneyDiagnostics"])(importOriginal as () => Promise<Loader>)
);

import "../src/builder.js";
import { bindings } from "../src/builder.js";
import { clearPanelMemory, writePanelMemory, type FormDefinition } from "@argusvane/datum-engine";
import { resetBuilderFeatureWarnings } from "../../../engine/form-engine/builder/web-component/builder-features.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

// A second look on the page, so the binding picker has something to offer beside Datum's.
bindings.register({ id: "fx-binding", label: "Features binding", components: {} });

const ALL_WORKSPACES = ["form", "logic", "data", "languages", "journeys", "pdf", "print"];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of Object.keys(asked) as Array<keyof typeof asked>) {
    asked[key] = 0;
  }
  onPage.chrome = false;
  onPage.variables = false;
  resetBuilderFeatureWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  clearPanelMemory("fx-t");
  warn.mockRestore();
});

function fullDefinition(): FormDefinition {
  const definition = sampleDefinition();
  definition.pdf = {
    layouts: [
      {
        id: "letter",
        kind: "generated",
        name: "Letter",
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      }
    ],
    defaultLayout: "letter"
  } as unknown as NonNullable<FormDefinition["pdf"]>;
  definition.journey = {
    journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }]
  } as NonNullable<FormDefinition["journey"]>;
  return definition;
}

async function mount(attributes: Record<string, string> = {}, definition: FormDefinition = fullDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

/** Waits for the modes that are on to have registered (a side left out never does). */
async function sidesSettled(element: DatumFormBuilderElement, pdf: boolean, journeys: boolean): Promise<void> {
  await until(() => (element.pdfMode !== undefined) === pdf && (element.journeyMode !== undefined) === journeys);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const stripIds = (element: DatumFormBuilderElement): string[] =>
  [...shell(element).querySelectorAll<HTMLElement>("[data-strip] [data-panel]")].filter((item) => !item.hidden).map((item) => item.dataset.panel!);
const canvas = (element: DatumFormBuilderElement): HTMLElement & { previewing: boolean } =>
  shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
const inspectorRoot = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const nothingAsked = { print: 0, pdf: 0, journeys: 0, chrome: 0, variables: 0, logic: 0, data: 0, languages: 0, overview: 0, palette: 0, json: 0, tryIt: 0, diagnostics: 0 };

/** Selects a component and waits for the inspector to draw it. */
async function inspect(element: DatumFormBuilderElement, id = "fullName"): Promise<ShadowRoot> {
  element.controller!.select(id);
  await until(() => inspectorRoot(element).querySelector("[data-inspector-tab]"));
  return inspectorRoot(element);
}

describe("without a features list the builder is today's, byte for byte", () => {
  it("offers every workspace, every strip panel, both designer modes and every inspector part", async () => {
    const element = await mount();
    await sidesSettled(element, true, true);
    expect(element.features).toBeUndefined();
    expect(element.getAttribute("features")).toBeNull();
    expect(element.builder!.getAttribute("features")).toBeNull();
    expect(element.builder!.availableWorkspaces()).toEqual(ALL_WORKSPACES);
    // The strip's items, in order; Translations waits for a source.
    expect(stripIds(element)).toEqual(["form", "chrome", "components", "outline", "variables", "tests", "view", "settings"]);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(false);
    expect(shell(element).querySelector<HTMLElement>("[data-settings-submit]")!.hidden).toBe(false);
    const tryIt = canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!;
    expect(tryIt.hidden).toBe(false);
    const root = await inspect(element);
    expect(root.querySelector("#prop-id")).toBeTruthy();
    expect(root.querySelector("[data-saved-as]")).toBeTruthy();
    expect(root.querySelector("[data-translation-pointer]")).toBeTruthy();
    expect(root.querySelector("[data-inspector-more]")).toBeTruthy();
    expect(root.querySelector('[data-inspector-tab="rules"]')).toBeTruthy();
    expect(root.querySelector('[data-prop="dataKey"]')).toBeTruthy();
    for (const feature of ["logic", "data", "languages", "translations", "journeys", "pdf", "print", "variables", "header-footer", "data-model", "palette", "try-it", "json", "binding-picker", "advanced-fields"] as const) {
      expect(element.featureEnabled(feature), feature).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("round trips the definition untouched", async () => {
    const definition = fullDefinition();
    const element = await mount({}, definition);
    await sidesSettled(element, true, true);
    expect(JSON.stringify(element.definition.root)).toBe(JSON.stringify(definition.root));
    expect(element.definition.journey).toEqual(definition.journey);
  });
});

describe("the counters below count real requests", () => {
  it("sees a request for every chunk when nothing is left out (the control for the zero assertions)", async () => {
    const element = await mount();
    await sidesSettled(element, true, true);
    expect(asked.pdf + asked.journeys).toBeGreaterThan(0);
    element.builder!.panel = "chrome";
    await until(() => asked.chrome > 0);
    element.builder!.panel = "variables";
    await until(() => asked.variables > 0);
    for (const workspace of ["logic", "data", "languages", "print", "journeys"] as const) {
      element.setWorkspace(workspace);
      await until(() => element.builder!.workspace === workspace);
    }
    await until(() => asked.logic > 0 && asked.data > 0 && asked.languages > 0 && asked.print > 0 && asked.overview > 0);
    element.setWorkspace("form");
    await element.openPalette();
    expect(asked.palette).toBeGreaterThan(0);
    await inspect(element);
    (shell(element).querySelector("datum-builder-properties") as unknown as { inspectorTab: string }).inspectorTab = "json";
    await until(() => asked.json > 0);
    canvas(element).previewing = true;
    await until(() => asked.tryIt > 0);
    await until(() => asked.diagnostics > 0, 6000);
    for (const [key, count] of Object.entries(asked)) {
      expect(count, key).toBeGreaterThan(0);
    }
  });
});

describe("features=\"minimal\": the form alone", () => {
  it("builds no workspace but the form, no designer mode, no strip item beyond the basic ones", async () => {
    const definition = fullDefinition();
    const element = await mount({ features: "minimal" }, definition);
    await settle();
    expect(element.features).toBe("minimal");
    expect(element.builder!.availableWorkspaces()).toEqual(["form"]);
    expect(element.pdfMode).toBeUndefined();
    expect(element.journeyMode).toBeUndefined();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(stripIds(element)).toEqual(["form", "components", "outline", "view", "settings"]);
    // One workspace: no switch at all.
    expect(shell(element).querySelector<HTMLElement>("[data-workspaces-nav]")!.hidden).toBe(true);
    // The layouts and journeys the definition carries pass through as given.
    expect(element.definition.pdf).toEqual(definition.pdf);
    expect(element.definition.journey).toEqual(definition.journey);
  });

  it("fetches no optional chunk at connect, on an edit, on undo or on a repaint", async () => {
    const element = await mount({ features: "minimal" });
    await settle();
    expect(asked).toEqual(nothingAsked);
    element.controller!.requestAddAfter("text", "fullName");
    await settle();
    element.controller!.undo();
    element.controller!.setPreviewWidth(768);
    element.controller!.setPreviewWidth(undefined);
    element.controller!.select("fullName");
    await until(() => inspectorRoot(element).querySelector("[data-inspector-tab]"));
    await settle();
    expect(asked).toEqual(nothingAsked);
  });

  it("reaches no left-out part by any route: workspaces, panels, the palette, Try it", async () => {
    const element = await mount({ features: "minimal" });
    const builder = element.builder!;
    for (const id of ["logic", "data", "languages", "journeys", "pdf", "print"] as const) {
      expect(builder.setWorkspace(id), id).toBe(false);
      expect(element.setWorkspace(id), id).toBe(false);
    }
    expect(builder.workspace).toBe("form");
    for (const id of ["chrome", "variables"]) {
      builder.panel = id;
      expect(builder.panel, id).not.toBe(id);
    }
    // The palette: a no-op that resolves with nothing, the key left to the page.
    await expect(element.openPalette()).resolves.toBeUndefined();
    const keyDown = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true, composed: true });
    builder.dispatchEvent(keyDown);
    expect(keyDown.defaultPrevented).toBe(false);
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(true);
    const off = element.registerCommands({ commands: () => [{ id: "host:save", label: "Save", group: "host", run: () => undefined }] });
    await element.openPalette();
    off();
    // Edit / Preview is the canvas's own and stays; Try it, the panel beside the live form (and its chunk), is the feature.
    const toggle = canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!;
    expect(toggle.hidden).toBe(false);
    canvas(element).previewing = true;
    expect(canvas(element).previewing).toBe(true);
    const panel = canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!;
    expect(panel.hidden).toBe(true);
    expect(panel.children).toHaveLength(0);
    expect(canvas(element).shadowRoot!.querySelector(".panel--canvas")!.hasAttribute("data-try-shown")).toBe(false);
    canvas(element).previewing = false;
    expect(shell(element).querySelector<HTMLElement>("[data-settings-submit]")!.hidden).toBe(true);
    await settle();
    expect(asked).toEqual(nothingAsked);
  });

  it("leaves out the inspector's JSON view, component id, data key, translation pointer line and Rules tab", async () => {
    const element = await mount({ features: "minimal" });
    const root = await inspect(element);
    expect(root.querySelector("[data-inspector-more]")).toBeNull();
    expect(root.querySelector('[data-inspector-tab="json"]')).toBeNull();
    expect(root.querySelector('[data-inspector-tab="rules"]')).toBeNull();
    expect(root.querySelector("#prop-id")).toBeNull();
    expect(root.querySelector("[data-saved-as]")).toBeNull();
    expect(root.querySelector('[data-prop="dataKey"]')).toBeNull();
    expect(root.querySelector("[data-translation-pointer]")).toBeNull();
    // The rest of the inspector is there.
    expect(root.querySelector('[data-prop="label"]')).toBeTruthy();
    // The selection bar has no Add logic.
    expect(canvas(element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="logic"]')!.hidden).toBe(true);
    expect(asked.json).toBe(0);
  });

  it("hides the binding picker, though `binding` still sets the look", async () => {
    const full = await mount();
    expect(shell(full).querySelector<HTMLElement>("[data-binding-field]")!.hidden).toBe(false);
    document.body.innerHTML = "";
    const element = await mount({ features: "minimal" });
    expect(shell(element).querySelector<HTMLElement>("[data-binding-field]")!.hidden).toBe(true);
  });
});

describe("minimal still lets you build, apply and save", () => {
  it("adds a component, applies an inspector edit and saves through the page's file action, with the definition", async () => {
    const element = await mount({ features: "minimal" });
    const save = vi.fn();
    element.fileActions = { save };
    const heard: Array<{ action: string; definition: FormDefinition }> = [];
    element.addEventListener("datum-builder-file-action", (event) =>
      heard.push((event as CustomEvent<{ action: string; definition: FormDefinition }>).detail)
    );
    const controller = element.controller!;
    expect(controller.requestAddAfter("text", "fullName")).toBe(true);
    const added = controller.selectedComponentId()!;
    expect(added).toBeTruthy();
    const root = await inspect(element, added);
    const box = root.querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    box.value = "Nickname";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const apply = root.querySelector<HTMLElement>("[data-inspector-save]")!;
    expect(apply.hasAttribute("disabled")).toBe(false);
    apply.click();
    const find = (nodes: unknown): unknown => JSON.stringify(nodes).includes(`"Nickname"`);
    expect(find(element.definition.root)).toBe(true);
    // Save: the item is on the bar, and the page's save runs.
    const item = shell(element).querySelector<HTMLButtonElement>("[data-file-save]")!;
    expect(item.hidden).toBe(false);
    item.click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(heard.map((detail) => detail.action)).toEqual(["save"]);
    expect(find(heard[0]!.definition.root)).toBe(true);
    expect(asked).toEqual(nothingAsked);
  });

  it("keeps a set data key through an inspector edit while advanced-fields is left out", async () => {
    const element = await mount({ features: "minimal" });
    const controller = element.controller!;
    controller.setDraftProperty("fullName", "dataKey", "full_name");
    expect(controller.commitDraft("fullName")).toBe(true);
    const root = await inspect(element, "fullName");
    expect(root.querySelector('[data-prop="dataKey"]')).toBeNull();
    const box = root.querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    box.value = "Edited name";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    root.querySelector<HTMLElement>("[data-inspector-save]")!.click();
    const node = controller.snapshot().children?.content?.find((child) => child.id === "fullName") ?? undefined;
    const found = JSON.stringify(controller.snapshot());
    expect(found).toContain("Edited name");
    expect(found).toContain('"dataKey":"full_name"');
    expect(node === undefined || (node.configuration as Record<string, unknown>).dataKey === "full_name").toBe(true);
  });

  it("still applies `binding` with the picker hidden", async () => {
    const element = await mount({ features: "minimal" });
    element.binding = "fx-binding";
    expect(shell(element).querySelector<HTMLElement>("[data-binding-field]")!.hidden).toBe(true);
    await until(() => element.controller!.bindingId() === "fx-binding");
    element.binding = "datum";
    await until(() => element.controller!.bindingId() === "datum");
  });
});

describe("a list names what exists", () => {
  it("brings back a workspace with its token: minimal logic is the form plus Logic, and Logic loads on entering", async () => {
    const element = await mount({ features: "minimal logic" });
    expect(element.features).toBe("logic");
    expect(element.builder!.availableWorkspaces()).toEqual(["form", "logic"]);
    expect(asked.logic).toBe(0);
    expect(element.setWorkspace("logic")).toBe(true);
    await until(() => shell(element).querySelector("datum-builder-logic"));
    expect(asked.logic).toBe(1);
    expect(asked.data + asked.languages + asked.overview + asked.pdf + asked.journeys).toBe(0);
    // Rules and Add logic come with it.
    element.setWorkspace("form");
    const root = await inspect(element);
    expect(root.querySelector('[data-inspector-tab="rules"]')).toBeTruthy();
    expect(canvas(element).shadowRoot!.querySelector<HTMLElement>('[data-selection-action="logic"]')!.hidden).toBe(false);
  });

  it("registers a designer mode only for its token, and fetches only that one", async () => {
    const pdf = await mount({ features: "pdf" });
    await sidesSettled(pdf, true, false);
    expect(pdf.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
    expect(pdf.builder!.availableWorkspaces()).toEqual(["form", "pdf"]);
    expect(asked.journeys).toBe(0);
    document.body.innerHTML = "";
    asked.pdf = 0;
    const journeys = await mount({ features: "journeys" });
    await sidesSettled(journeys, false, true);
    expect(journeys.modes.map((mode) => mode.id)).toEqual(["form", "journeys"]);
    expect(journeys.builder!.availableWorkspaces()).toEqual(["form", "journeys"]);
    expect(asked.pdf).toBe(0);
  });

  it("asks for no journey diagnostics without the journeys token", async () => {
    // A builder of an earlier test counts its problems a moment after its last change: let that pass.
    await new Promise((resolve) => setTimeout(resolve, 500));
    asked.diagnostics = 0;
    const element = await mount({ features: "pdf logic" });
    await sidesSettled(element, true, false);
    element.controller!.requestAddAfter("text", "fullName");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asked.diagnostics).toBe(0);
  });

  it("offers the Variables and Header & footer panels for their tokens, loading each on opening", async () => {
    const element = await mount({ features: "variables header-footer" });
    expect(stripIds(element)).toEqual(["form", "chrome", "components", "outline", "variables", "view", "settings"]);
    expect(asked.chrome + asked.variables).toBe(0);
    element.builder!.panel = "chrome";
    await until(() => shell(element).querySelector("datum-builder-chrome-panel")?.shadowRoot?.querySelector(".chrome-head"));
    expect(asked.chrome).toBe(1);
    expect(asked.variables).toBe(0);
  });

  it("opens the palette for its token, fetching its chunk then and not before", async () => {
    const element = await mount({ features: "palette" });
    expect(asked.palette).toBe(0);
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(false);
    await element.openPalette();
    expect(asked.palette).toBe(1);
    expect((shell(element).querySelector("datum-builder-palette") as unknown as { isOpen: boolean }).isOpen).toBe(true);
  });

  it("offers Try it for its token", async () => {
    const element = await mount({ features: "try-it" });
    expect(canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(false);
    expect(shell(element).querySelector<HTMLElement>("[data-settings-submit]")!.hidden).toBe(false);
    canvas(element).previewing = true;
    expect(canvas(element).previewing).toBe(true);
    expect(canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!.hidden).toBe(false);
    await until(() => asked.tryIt > 0);
  });

  it("offers the inspector's parts for json, translations and advanced-fields, each alone", async () => {
    const json = await mount({ features: "json" });
    let root = await inspect(json);
    expect(root.querySelector("[data-inspector-more]")).toBeTruthy();
    expect(root.querySelector("#prop-id")).toBeNull();
    expect(root.querySelector("[data-translation-pointer]")).toBeNull();
    document.body.innerHTML = "";
    const translations = await mount({ features: "translations" });
    root = await inspect(translations);
    expect(root.querySelector("[data-translation-pointer]")).toBeTruthy();
    expect(root.querySelector("[data-inspector-more]")).toBeNull();
    document.body.innerHTML = "";
    const advanced = await mount({ features: "advanced-fields" });
    root = await inspect(advanced);
    expect(root.querySelector("#prop-id")).toBeTruthy();
    expect(root.querySelector("[data-saved-as]")).toBeTruthy();
    expect(root.querySelector('[data-prop="dataKey"]')).toBeTruthy();
    expect(root.querySelector("[data-translation-pointer]")).toBeNull();
    // Three builders mounted in one test: slow under load, so the 5 s default is short.
  }, 30000);

  it("shows the binding picker for the binding-picker token", async () => {
    const element = await mount({ features: "binding-picker" });
    expect(shell(element).querySelector<HTMLElement>("[data-binding-field]")!.hidden).toBe(false);
  });

  it("leaves the Header & footer panel's JSON menu to the json token, by the panel's own property", async () => {
    const without = await mount({ features: "header-footer" });
    without.builder!.panel = "chrome";
    await until(() => shell(without).querySelector("datum-builder-chrome-panel")?.shadowRoot?.querySelector(".chrome-head"));
    const bare = shell(without).querySelector("datum-builder-chrome-panel") as HTMLElement & { jsonEnabled: boolean };
    expect(bare.jsonEnabled).toBe(false);
    expect(bare.shadowRoot!.querySelector("[data-chrome-more]")).toBeNull();
    expect(bare.shadowRoot!.querySelector("[data-chrome-menu]")).toBeNull();
    // No shadow-root style rules any more: the markup itself leaves the menu out.
    expect(bare.shadowRoot!.querySelector("style[data-features]")).toBeNull();
    document.body.innerHTML = "";
    onPage.chrome = false;
    const withJson = await mount({ features: "header-footer json" });
    withJson.builder!.panel = "chrome";
    await until(() => shell(withJson).querySelector("datum-builder-chrome-panel")?.shadowRoot?.querySelector(".chrome-head"));
    const panel = shell(withJson).querySelector("datum-builder-chrome-panel") as HTMLElement & { jsonEnabled: boolean };
    expect(panel.jsonEnabled).toBe(true);
    expect(panel.shadowRoot!.querySelector("[data-chrome-more]")).toBeTruthy();
  });

  it("leaves the Data workspace's data-model import and JSON views to their tokens, by the surface's own properties", async () => {
    const surfaceOf = async (features: string) => {
      document.body.innerHTML = "";
      const element = await mount({ features });
      element.setWorkspace("data");
      await until(() => shell(element).querySelector("datum-builder-data")?.shadowRoot?.querySelector("[data-data-main] .data-head"));
      const surface = shell(element).querySelector("datum-builder-data") as HTMLElement & { importEnabled: boolean; jsonEnabled: boolean };
      expect(surface.shadowRoot!.querySelector("style[data-features]")).toBeNull();
      return surface;
    };
    let surface = await surfaceOf("data");
    expect([surface.importEnabled, surface.jsonEnabled]).toEqual([false, false]);
    expect(surface.shadowRoot!.querySelector("[data-data-import]")).toBeNull();
    expect(surface.shadowRoot!.querySelector("[data-data-view]")).toBeNull();
    // The import dialog stays shut with nothing to open it; the rows are there.
    expect(surface.shadowRoot!.querySelector("[data-data-row]")).toBeTruthy();
    surface = await surfaceOf("data data-model");
    expect(surface.shadowRoot!.querySelector("[data-data-import]")).toBeTruthy();
    // The Schema and Example views are data-model output as JSON: they wait for json too.
    expect(surface.shadowRoot!.querySelector("[data-data-view]")).toBeNull();
    surface = await surfaceOf("data data-model json");
    expect(surface.shadowRoot!.querySelector("[data-data-import]")).toBeTruthy();
    expect(surface.shadowRoot!.querySelectorAll("[data-data-view]")).toHaveLength(3);
    expect(asked.json).toBe(0);
    // It builds four builders in turn: past the default 5 s under a loaded run, though it passes alone.
  }, 40000);

  it("draws no Edit header/footer buttons without header-footer", async () => {
    const formPanel = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    const open = async (features: string): Promise<ShadowRoot> => {
      document.body.innerHTML = "";
      const element = await mount({ features });
      element.builder!.panel = "form";
      await until(() => formPanel(element).querySelector(".panel"));
      return formPanel(element);
    };
    const without = await open("minimal");
    expect(without.querySelector("[data-chrome-open]")).toBeNull();
    const withChrome = await open("header-footer");
    await until(() => withChrome.querySelector("[data-chrome-open]"));
  });

  it("draws the Form panel's Formulas section only with logic; Print and Localization are no sections any more (the Print workspace)", async () => {
    const formPanel = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    const sectionsOf = async (features: string | undefined): Promise<string[]> => {
      document.body.innerHTML = "";
      const element = await mount(features === undefined ? {} : { features });
      element.builder!.panel = "form";
      await until(() => formPanel(element).querySelector(".panel"));
      return ["print", "formulas", "localization"].filter((id) => formPanel(element).querySelector(`[data-inspector-section="${id}"]`));
    };
    expect(await sectionsOf(undefined)).toEqual(["formulas"]);
    expect(await sectionsOf("minimal")).toEqual([]);
    expect(await sectionsOf("pdf")).toEqual([]);
    expect(await sectionsOf("print")).toEqual([]);
    expect(await sectionsOf("logic")).toEqual(["formulas"]);
    expect(await sectionsOf("languages")).toEqual([]);
  }, 40000);

  it("draws Logic's open-designer buttons only for a side the list names", async () => {
    const definition = fullDefinition();
    (definition.pdf!.layouts![0]! as { when?: unknown }).when = { kind: "path", path: "fullName" };
    // A journey's condition lives on a route now (a step has none of its own).
    (definition.journey!.journeys![0]!.pages[0]! as { routes?: unknown }).routes = [{ when: { kind: "path", path: "fullName" }, to: "$end" }];
    const logicRoot = async (features: string): Promise<ShadowRoot> => {
      document.body.innerHTML = "";
      const element = await mount({ features }, definition);
      await sidesSettled(element, features.includes("pdf"), features.includes("journeys"));
      element.setWorkspace("logic");
      await until(() => shell(element).querySelector("datum-builder-logic")?.shadowRoot?.querySelector("[data-logic-rule]"));
      const root = shell(element).querySelector("datum-builder-logic")!.shadowRoot!;
      // A journey's rule is editable here once the Journeys mode has its designer in: it is listed read-only until then.
      if (features.includes("journeys")) {
        await until(() => root.querySelector('[data-logic-rule^="journeys:"]') && !root.querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
      }
      return root;
    };
    const docs = (root: ShadowRoot): string[] => [...root.querySelectorAll<HTMLElement>("[data-logic-open-doc]")].map((button) => button.dataset.logicOpenDoc!);
    expect(docs(await logicRoot("logic"))).toEqual([]);
    expect(docs(await logicRoot("logic pdf"))).toEqual(["pdf"]);
    // A journey's Go to rule is edited in Logic itself, so it has no button to the designer where the Journeys side is on.
    expect(docs(await logicRoot("logic journeys"))).toEqual([]);
    expect(docs(await logicRoot("logic pdf journeys"))).toEqual(["pdf"]);
  }, 40000);
});

describe("the list is the master: the other attributes only restrict", () => {
  it.each([
    ["auto", "pdf"],
    ["/static/datum-pdf.js", "pdf"]
  ])("ignores pdf=%s when pdf is not listed, with one warning", async (value) => {
    const element = await mount({ features: "logic", pdf: value });
    await settle();
    expect(element.pdfMode).toBeUndefined();
    expect(asked.pdf).toBe(0);
    expect(element.builder!.availableWorkspaces()).not.toContain("pdf");
    const messages = warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes("pdf attribute ignored: not in features"));
    expect(messages).toHaveLength(1);
    // Asked again by a reconnect: still one.
    element.remove();
    document.body.append(element);
    await settle();
    expect(warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes("pdf attribute ignored"))).toHaveLength(1);
  });

  it("refuses a pdf attribute on another origin once, before the list is asked, and loads nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = await mount({ features: "logic", pdf: "https://example.test/pdf.js" });
    await settle();
    const refusals = () => error.mock.calls.map((call) => String(call[0])).filter((text) => text.includes("pdf attribute was not used"));
    expect(refusals()).toHaveLength(1);
    expect(asked.pdf).toBe(0);
    element.remove();
    document.body.append(element);
    await settle();
    expect(refusals()).toHaveLength(1);
    expect(element.pdfMode).toBeUndefined();
    // Refused, the attribute is absent: there is nothing for the list to ignore.
    expect(warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes("pdf attribute ignored"))).toHaveLength(0);
  });

  it("ignores journeys=auto when journeys is not listed, with one warning", async () => {
    const element = await mount({ features: "pdf", journeys: "auto" });
    await sidesSettled(element, true, false);
    expect(asked.journeys).toBe(0);
    expect(warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes("journeys attribute ignored: not in features"))).toHaveLength(1);
  });

  it("lets pdf=off, journeys=off and hidden-workspaces take a listed side away, and fetches nothing for it", async () => {
    const off = await mount({ features: "pdf journeys", pdf: "off", journeys: "off" });
    await settle();
    expect(off.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(asked.pdf + asked.journeys).toBe(0);
    document.body.innerHTML = "";
    const hidden = await mount({ features: "pdf journeys", "hidden-workspaces": "pdf journeys" });
    await settle();
    expect(hidden.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(asked.pdf + asked.journeys).toBe(0);
    document.body.innerHTML = "";
    const logic = await mount({ features: "logic data", "hidden-workspaces": "logic" });
    expect(logic.builder!.availableWorkspaces()).toEqual(["form", "data"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never returns to a workspace the list took away: logic pdf, Logic, PDF, then features pdf and pdf=off lands on Form with no Logic fetch", async () => {
    const element = await mount({ features: "logic pdf" });
    await sidesSettled(element, true, false);
    const builder = element.builder!;
    expect(element.setWorkspace("logic")).toBe(true);
    await until(() => builder.workspace === "logic" && shell(element).querySelector("datum-builder-logic"));
    expect(element.setWorkspace("pdf")).toBe(true);
    await until(() => builder.workspace === "pdf");
    asked.logic = 0;
    // pdf is still allowed, so nothing switches; Logic is gone from the list.
    element.setAttribute("features", "pdf");
    await settle();
    expect(builder.workspace).toBe("pdf");
    expect(builder.availableWorkspaces()).toEqual(["form", "pdf"]);
    element.setAttribute("pdf", "off");
    await settle();
    expect(builder.workspace).toBe("form");
    expect(asked.logic).toBe(0);
    // And the other way back, by the mode.
    expect(builder.availableWorkspaces()).toEqual(["form"]);
  });

  it("falls back to the form, with the same warning, when the workspace asked for is not listed", async () => {
    const element = await mount({ features: "logic", workspace: "pdf" });
    expect(element.workspace).toBe("form");
    expect(element.builder!.workspace).toBe("form");
    expect(warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes("not in features"))).toHaveLength(1);
    document.body.innerHTML = "";
    // A listed workspace asked for first is honoured.
    const listed = await mount({ features: "logic", workspace: "logic" });
    await until(() => listed.builder!.workspace === "logic");
  });

  it("falls back whichever of workspace and features comes first in the markup", async () => {
    const element = document.createElement("datum-form-builder");
    element.setAttribute("workspace", "data");
    element.setAttribute("features", "minimal");
    element.definition = fullDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    expect(element.builder!.workspace).toBe("form");
    expect(asked.data).toBe(0);
  });

  it("lets hidden-panels take a listed panel away, and the list refuse a panel hidden-panels would keep", async () => {
    const element = await mount({ features: "variables header-footer", "hidden-panels": "variables" });
    expect(stripIds(element)).toEqual(["form", "chrome", "components", "outline", "view", "settings"]);
    element.builder!.panel = "variables";
    expect(element.builder!.panel).not.toBe("variables");
    await settle();
    expect(asked.variables).toBe(0);
  });

  it("leaves component-types and file-actions as they were, whatever the list", async () => {
    const element = await mount({ features: "minimal", "component-types": "text select", "file-actions": "open" });
    const types = element.controller!.componentTypes().map((entry) => entry.type);
    expect(types).toEqual(["text", "select"]);
    expect(Object.keys(element.fileActions)).toEqual(expect.arrayContaining(["open"]));
    expect(element.fileActions.new).toBeUndefined();
    expect(element.fileActions.download).toBeUndefined();
    document.body.innerHTML = "";
    // And a list that names everything does not widen them.
    const all = await mount({ features: "all", "component-types": "text", "file-actions": "off" });
    expect(all.controller!.componentTypes().map((entry) => entry.type)).toEqual(["text"]);
    expect(Object.keys(all.fileActions)).toEqual([]);
  });
});

describe("hidden-panels on its own", () => {
  it("takes panels off the strip and never loads them", async () => {
    const element = await mount({ "hidden-panels": "chrome variables" });
    await settle();
    expect(stripIds(element)).toEqual(["form", "components", "outline", "tests", "view", "settings"]);
    expect(element.hiddenPanels).toEqual(["chrome", "variables"]);
    element.builder!.panel = "chrome";
    expect(element.builder!.panel).toBe("components");
    expect(asked.chrome + asked.variables).toBe(0);
    // Everything else is today's.
    expect(element.builder!.availableWorkspaces()).toEqual(ALL_WORKSPACES);
  });

  it("never opens a hidden panel remembered, the workspace's own opens instead", async () => {
    writePanelMemory("fx-t", { panel: "chrome", propsCollapsed: false });
    const element = await mount({ "persist-panels": "fx-t", "hidden-panels": "chrome" });
    await settle();
    expect(element.builder!.panel).toBe("components");
    expect(asked.chrome).toBe(0);
  });

  it("is a property too, changed at any time", async () => {
    const element = await mount();
    element.hiddenPanels = ["outline"];
    expect(element.builder!.hiddenPanels).toEqual(["outline"]);
    expect(stripIds(element)).not.toContain("outline");
    element.hiddenPanels = [];
    expect(stripIds(element)).toContain("outline");
  });

  it("closes the panel that is open when it is hidden", async () => {
    const element = await mount();
    element.builder!.panel = "outline";
    element.hiddenPanels = ["outline"];
    expect(element.builder!.panel).toBe("components");
  });
});

describe("the features property", () => {
  it("mirrors the attribute: a string, an array, the same normalised list out", async () => {
    const element = await mount();
    element.features = ["pdf", "logic"];
    expect(element.getAttribute("features")).toBe("pdf logic");
    expect(element.features).toBe("logic pdf");
    element.features = "Data, LOGIC";
    expect(element.features).toBe("logic data");
    element.features = "all";
    expect(element.features).toBe("all");
    element.features = "";
    expect(element.features).toBe("minimal");
    element.features = undefined;
    expect(element.features).toBeUndefined();
    expect(element.hasAttribute("features")).toBe(false);
    element.features = null;
    expect(element.hasAttribute("features")).toBe(false);
  });

  it("reports a word that names nothing as a datum-error on the element, as <datum-form> does", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form-builder");
    const heard: string[] = [];
    element.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    element.definition = fullDefinition();
    element.setAttribute("features", "journeys, agnet");
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    expect(heard).toEqual(['features names no such feature or preset: "agnet"']);
    // Known words, the presets and the form workspace's own name are not reported; each assignment says its own.
    heard.length = 0;
    element.features = "minimal logic form";
    element.features = ["all", "agent"];
    element.features = "Pdff typo, logic";
    await settle();
    expect(heard).toEqual(['features names no such feature or preset: "pdff", "typo"']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("warns once for a word that names nothing, and ignores it", async () => {
    const element = await mount({ features: "logic wrong" });
    element.features = "logic wrong";
    element.features = "wrong data";
    await settle();
    const unknown = warn.mock.calls.map((call: readonly unknown[]) => String(call[0])).filter((text: string) => text.includes('unknown feature "wrong"'));
    expect(unknown).toHaveLength(1);
    expect(element.features).toBe("data");
  });

  it("rebuilds when it changes after connect: sides, workspaces, strip, bar and inspector", async () => {
    const element = await mount();
    await sidesSettled(element, true, true);
    element.setWorkspace("logic");
    await until(() => element.builder!.workspace === "logic");
    element.builder!.panel = "variables";

    element.features = "minimal";
    await sidesSettled(element, false, false);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(element.builder!.availableWorkspaces()).toEqual(["form"]);
    // The workspace on the page gave way, the panel with it.
    expect(element.builder!.workspace).toBe("form");
    expect(stripIds(element)).toEqual(["form", "components", "outline", "view", "settings"]);
    expect(element.builder!.panel).not.toBe("variables");
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(true);
    expect(shell(element).querySelector<HTMLElement>("[data-settings-submit]")!.hidden).toBe(true);
    // What the PDF and Journeys sides held stays in the definition.
    expect(element.definition.pdf).toBeTruthy();
    expect(element.definition.journey).toBeTruthy();

    element.features = "pdf logic";
    await sidesSettled(element, true, false);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
    expect(element.builder!.availableWorkspaces()).toEqual(["form", "logic", "pdf"]);
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(true);

    element.features = undefined;
    await sidesSettled(element, true, true);
    expect(element.builder!.availableWorkspaces()).toEqual(ALL_WORKSPACES);
    expect(stripIds(element)).toContain("variables");
    expect(shell(element).querySelector<HTMLElement>("[data-palette-open]")!.hidden).toBe(false);
    expect(shell(element).querySelector<HTMLElement>("[data-settings-submit]")!.hidden).toBe(false);
  });

  it("takes the Try it panel down when the list leaves it out while it is up, the preview staying", async () => {
    const element = await mount();
    canvas(element).previewing = true;
    const panel = canvas(element).shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => !panel.hidden);
    element.features = "minimal";
    await until(() => panel.hidden);
    expect(canvas(element).previewing).toBe(true);
    element.features = undefined;
    await until(() => !panel.hidden);
  });

  it("keeps the layouts edited on the PDF side when the list takes the side away", async () => {
    const element = await mount();
    await sidesSettled(element, true, true);
    expect(element.pdfMode!.layouts.length).toBeGreaterThan(0);
    element.pdfMode!.newLayout({ name: "Second", from: "blank" });
    const count = element.definition.pdf!.layouts!.length;
    expect(count).toBeGreaterThan(1);
    element.features = "logic";
    await until(() => element.pdfMode === undefined);
    expect(element.definition.pdf!.layouts!.length).toBe(count);
  });
});

describe("the PDF layouts alone (workspaces=\"pdf\") with a list", () => {
  it("is the PDF side alone under a features list that names pdf, and fetches no journeys", async () => {
    const designer = pdfAlone();
    designer.setAttribute("features", "minimal pdf");
    designer.definition = fullDefinition();
    document.body.append(designer);
    await until(() => designer.pdfMode !== undefined);
    expect(designer.modes.map((mode) => mode.id)).toContain("pdf");
    expect(designer.builder!.availableWorkspaces()).toEqual(["pdf"]);
    expect(asked.journeys).toBe(0);
  });
});
