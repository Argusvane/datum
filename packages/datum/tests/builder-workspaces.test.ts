import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { clearPanelMemory, readPanelMemory, writePanelMemory, type BuilderWorkspaceChangeDetail, type PdfGeneratedLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/** The builder's workspaces: Form, Logic, Data, Languages, Journeys, PDF and Print over the panels and the modes. */

afterEach(() => {
  document.body.innerHTML = "";
  clearPanelMemory("ws-t");
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const tab = (element: DatumFormBuilderElement, id: string): HTMLButtonElement => shell(element).querySelector<HTMLButtonElement>(`[data-workspace-tab="${id}"]`)!;
const stripItem = (element: DatumFormBuilderElement, id: string): HTMLElement => shell(element).querySelector<HTMLElement>(`[data-strip] [data-panel="${id}"]`)!;
const offered = (element: DatumFormBuilderElement, id: string): boolean => !stripItem(element, id).hasAttribute("data-out-of-workspace");

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // The modes are chunks: Journeys and PDF are offered once they register.
  await modesReady(element);
  return element;
}

describe("builder workspaces", () => {
  it("opens on Form: seven tabs, the first selected, the strip showing Form's panels", async () => {
    const element = await mount();
    const builder = element.builder!;
    expect(builder.workspace).toBe("form");
    expect(builder.getAttribute("workspace")).toBe("form");
    const tabs = [...shell(element).querySelectorAll<HTMLElement>("[data-workspace-tab]")].map((entry) => [entry.textContent, entry.getAttribute("aria-selected"), entry.tabIndex]);
    expect(tabs).toEqual([
      ["Form", "true", 0],
      ["Logic", "false", -1],
      ["Data", "false", -1],
      ["Languages", "false", -1],
      ["Journeys", "false", -1],
      ["PDF", "false", -1],
      ["Print", "false", -1]
    ]);
    expect(builder.availableWorkspaces()).toEqual(["form", "logic", "data", "languages", "journeys", "pdf", "print"]);
    for (const id of ["form", "chrome", "outline", "view", "settings"]) expect(offered(element, id), id).toBe(true);
    // The form's settings panel is "Form settings", apart from the Form tab.
    expect(stripItem(element, "form").getAttribute("aria-label") ?? stripItem(element, "form").textContent).toMatch(/Form settings/);
    // The palette is the rail's All components in Form; its strip tab is for the designers, which have no rail.
    for (const id of ["components", "variables"]) expect(offered(element, id), id).toBe(false);
    // The data model is the Data workspace's, with its Import; the strip has no panel for it.
    expect(shell(element).querySelector('[data-strip] [data-panel="data-model"]')).toBeNull();
    // The sample form has components, so the palette starts shut; an empty form opens it.
    expect(builder.panel).toBeUndefined();
    expect(shell(element).querySelector("[data-rail-more]")!.getAttribute("aria-pressed")).toBe("false");
    // The show-hidden switch is on the View panel, Form's alone, not the strip.
    expect(shell(element).querySelector("[data-strip-card] [data-show-hidden]")).toBeNull();
    expect(shell(element).querySelector("[data-view-panel] [data-show-hidden]")).not.toBeNull();
  });

  it("switches on a click: each workspace opens its own panel, remembers it, and says so", async () => {
    const element = await mount();
    const builder = element.builder!;
    const heard: BuilderWorkspaceChangeDetail[] = [];
    builder.addEventListener("builder-workspace-change", (event) => heard.push((event as CustomEvent<BuilderWorkspaceChangeDetail>).detail));

    tab(element, "data").click();
    expect(builder.workspace).toBe("data");
    // Data opens on its schema table, no drawer.
    expect(builder.panel).toBeUndefined();
    expect(offered(element, "settings")).toBe(true);
    expect(offered(element, "components")).toBe(false);
    stripItem(element, "variables").click();
    expect(builder.panel).toBe("variables");

    tab(element, "form").click();
    // Form comes back as it was left: with no drawer.
    expect(builder.panel).toBeUndefined();
    tab(element, "data").click();
    // The panel last open there, not the workspace's default.
    expect(builder.panel).toBe("variables");
    expect(heard.map((detail) => `${detail.previous}→${detail.workspace}`)).toEqual(["form→data", "data→form", "form→data"]);
    expect(builder.getAttribute("workspace")).toBe("data");
  });

  it("opens Logic with no drawer and its own surface, the selection's rule open in it", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.controller.select("email");
    await until(() => inspector(element).querySelector('input[data-prop="id"]'));
    tab(element, "logic").click();
    expect(builder.panel).toBeUndefined();
    const logic = (): ShadowRoot | null | undefined => shell(element).querySelector("datum-builder-logic")?.shadowRoot;
    await until(() => logic()?.querySelector("[data-logic-editor] h2")?.textContent === "Show a field");
    tab(element, "form").click();
    expect(builder.panel).toBeUndefined();
  });

  it("opens Print with no drawer and its own surface, the canvas and the inspector put away, and remembers it", async () => {
    const element = await mount((el) => el.setAttribute("persist-panels", "ws-t"));
    const builder = element.builder!;
    builder.controller.select("email");
    await until(() => inspector(element).querySelector('input[data-prop="id"]'));
    tab(element, "print").click();
    expect(builder.workspace).toBe("print");
    expect(builder.panel).toBeUndefined();
    await until(() => shell(element).querySelector("datum-builder-print")?.shadowRoot?.querySelector("[data-print-settings] h2"));
    expect(shell(element).querySelector<HTMLElement>("[data-print-host]")!.hidden).toBe(false);
    expect(shell(element).querySelector(".wrap")!.getAttribute("data-workspace")).toBe("print");
    // Variables (placeholders), Tests and Settings are Print's strip panels; the palette and View are Form's.
    for (const id of ["variables", "tests", "settings"]) expect(offered(element, id), id).toBe(true);
    for (const id of ["components", "view", "chrome"]) expect(offered(element, id), id).toBe(false);
    expect(readPanelMemory("ws-t")?.workspace).toBe("print");
    tab(element, "form").click();
    expect(shell(element).querySelector<HTMLElement>("[data-print-host]")!.hidden).toBe(true);
  });

  it("opens PDF on its overview, a card into a designer and back, and follows a mode change made anywhere else", async () => {
    // A layout to open: none is derived for a form that declares none.
    const letter: PdfGeneratedLayout = { id: "letter", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
    const element = await mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [letter] } };
    });
    const builder = element.builder!;
    const overview = (): ShadowRoot | null | undefined => shell(element).querySelector("datum-builder-overview")?.shadowRoot;
    const host = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-overview-host]")!;
    tab(element, "data").click();
    tab(element, "pdf").click();
    expect(builder.workspace).toBe("pdf");
    expect(builder.mode).toBe("form");
    expect(builder.panel).toBeUndefined();
    expect(shell(element).querySelector("[data-shell=wrap]")!.hasAttribute("data-overview")).toBe(true);
    await until(() => overview()?.querySelector('[data-overview-open="pdf"]'));
    // The PDF overview lists the layouts alone: no journeys, no form card.
    expect(overview()!.querySelector("[data-overview-section]")!.getAttribute("data-overview-section")).toBe("pdf");
    expect(overview()!.querySelector('[data-overview-open="journeys"], [data-overview-open="form"]')).toBeNull();
    // A card opens its document's designer, with the way back to the overview on the bar.
    overview()!.querySelector<HTMLButtonElement>('[data-overview-open="pdf"]')!.click();
    await until(() => builder.mode === "pdf");
    expect(builder.workspace).toBe("pdf");
    expect(host().hidden).toBe(true);
    await until(() => shell(element).querySelector<HTMLElement>("[data-overview-back]")?.hidden === false);
    const back = shell(element).querySelector<HTMLButtonElement>("[data-overview-back]")!;
    expect(back.textContent).toBe("‹ Layouts");
    expect(back.getAttribute("aria-label")).toBe("Back to the PDF layouts");
    // It leads the document's pill, after the workspace tabs, so the tabs never move when it shows.
    expect(back.parentElement).toBe(shell(element).querySelector("[data-documents]"));
    expect(back.nextElementSibling!.matches("[data-overview-back-sep]:not([hidden])")).toBe(true);
    expect(back.nextElementSibling!.nextElementSibling!.matches("[data-document-picker-wrap]")).toBe(true);
    expect(shell(element).querySelector(".bar-start [data-overview-back]")).toBeNull();
    back.click();
    await until(() => builder.mode === "form");
    expect(builder.workspace).toBe("pdf");
    expect(host().hidden).toBe(false);
    // The Form tab from the overview: the form's own workspace again.
    tab(element, "form").click();
    expect(builder.workspace).toBe("form");
    expect(host().hidden).toBe(true);
    // The form back on the page any other way (setMode, selectDocument): the last form workspace.
    tab(element, "data").click();
    builder.setMode("pdf");
    await until(() => builder.mode === "pdf");
    expect(builder.workspace).toBe("pdf");
    expect(tab(element, "pdf").getAttribute("aria-selected")).toBe("true");
    builder.setMode("form");
    await until(() => builder.mode === "form");
    expect(builder.workspace).toBe("data");
  });

  it("opens Journeys on its overview, and the PDF tab from a journey's designer opens the PDF overview", async () => {
    const element = await mount((el) => {
      el.definition = {
        ...sampleDefinition(),
        journey: { journeys: [{ id: "intake", name: "Intake", pages: [{ id: "about", title: "About you", components: ["fullName"] }] }] }
      };
    });
    const builder = element.builder!;
    const overview = (): ShadowRoot | null | undefined => shell(element).querySelector("datum-builder-overview")?.shadowRoot;
    tab(element, "journeys").click();
    expect(builder.workspace).toBe("journeys");
    expect(builder.mode).toBe("form");
    await until(() => overview()?.querySelector('[data-overview-open="journeys"]'));
    expect(overview()!.querySelector('[data-overview-add="journeys"]')).not.toBeNull();
    expect(overview()!.querySelector('[data-overview-open="pdf"]')).toBeNull();
    overview()!.querySelector<HTMLButtonElement>('[data-overview-open="journeys"]')!.click();
    await until(() => builder.mode === "journeys");
    expect(builder.workspace).toBe("journeys");
    await until(() => shell(element).querySelector<HTMLElement>("[data-overview-back]")?.hidden === false);
    expect(shell(element).querySelector("[data-overview-back]")!.textContent).toBe("‹ Journeys");
    // From the journey's designer straight to the other designer's tab: its overview, not a layout.
    tab(element, "pdf").click();
    await until(() => builder.mode === "form");
    expect(builder.workspace).toBe("pdf");
    await until(() => overview()?.querySelector("[data-overview-section]")?.getAttribute("data-overview-section") === "pdf");
    expect(overview()!.querySelector("[data-overview-pdf-none]")).not.toBeNull();
    expect(overview()!.querySelector('[data-overview-add="pdf"]')).not.toBeNull();
    // Back to Journeys: its overview again.
    tab(element, "journeys").click();
    await until(() => overview()?.querySelector("[data-overview-section]")?.getAttribute("data-overview-section") === "journeys");
    expect(builder.mode).toBe("form");
  });

  it("offers Journeys and PDF only while their modes are on, and leaves an overview whose mode goes", async () => {
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    const builder = element.builder!;
    expect(builder.availableWorkspaces()).toEqual(["form", "logic", "data", "languages", "pdf", "print"]);
    expect(tab(element, "journeys").hidden).toBe(true);
    tab(element, "logic").click();
    tab(element, "pdf").click();
    expect(builder.workspace).toBe("pdf");
    builder.removeMode("pdf");
    expect(builder.workspace).toBe("logic");
    expect(tab(element, "pdf").hidden).toBe(true);
    expect(builder.setWorkspace("pdf")).toBe(false);
  });

  it("holds a switch behind the unsaved-edits prompt, and goes through once the draft is discarded", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.controller.select("email");
    await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === "email");
    const label = inspector(element).querySelector<HTMLInputElement>('input[data-prop="label"], input[data-prop$=".label"]')!;
    label.focus();
    label.value = "Work email";
    label.dispatchEvent(new Event("input", { bubbles: true }));

    expect(builder.setWorkspace("data")).toBe(false);
    await until(() => inspector(element).querySelector("[data-unsaved-prompt]"));
    expect(builder.workspace).toBe("form");
    inspector(element).querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    await until(() => builder.workspace === "data");
  });

  it("leaves off the workspaces a host hides, moving off one that goes", async () => {
    const element = await mount((el) => el.setAttribute("hidden-workspaces", "logic"));
    const builder = element.builder!;
    expect(tab(element, "logic").hidden).toBe(true);
    expect(builder.availableWorkspaces()).toEqual(["form", "data", "languages", "journeys", "pdf", "print"]);
    expect(builder.setWorkspace("logic")).toBe(false);
    tab(element, "data").click();
    builder.hiddenWorkspaces = ["data"];
    expect(builder.workspace).toBe("form");
    expect(tab(element, "data").hidden).toBe(true);
    expect(tab(element, "logic").hidden).toBe(false);
  });

  it("opens on the host's workspace attribute, and a remembered one wins over it", async () => {
    const first = await mount((el) => el.setAttribute("workspace", "data"));
    expect(first.builder!.workspace).toBe("data");
    document.body.innerHTML = "";

    writePanelMemory("ws-t", { panel: "outline", propsCollapsed: false, workspace: "logic" });
    const second = await mount((el) => {
      el.setAttribute("persist-panels", "ws-t");
      el.setAttribute("workspace", "data");
    });
    expect(second.builder!.workspace).toBe("logic");
    tab(second, "form").click();
    expect(readPanelMemory("ws-t")?.workspace).toBe("form");
  });

  it("moves between the tabs with the arrow keys, one Tab stop for the row", async () => {
    const element = await mount();
    const form = tab(element, "form");
    form.focus();
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tab(element, "logic").tabIndex).toBe(0);
    expect(form.tabIndex).toBe(-1);
    expect(shell(element).activeElement).toBe(tab(element, "logic"));
    tab(element, "logic").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(shell(element).activeElement).toBe(tab(element, "print"));
    // Moving focus does not switch: Enter or a click does.
    expect(element.builder!.workspace).toBe("form");
  });

  it("switches from the narrow bar's menu, which follows the workspace", async () => {
    const element = await mount();
    const menu = shell(element).querySelector<HTMLSelectElement>("[data-workspace-menu]")!;
    expect(menu.value).toBe("form");
    menu.value = "data";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.builder!.workspace).toBe("data");
    tab(element, "logic").click();
    expect(menu.value).toBe("logic");
  });

  it("shows a host's strip item in the workspaces it names, and in every one when it names none", async () => {
    const element = await mount();
    const builder = element.builder!;
    const sources = document.createElement("button");
    sources.slot = "strip";
    sources.dataset.panel = "host-sources";
    sources.dataset.workspace = "data";
    const help = document.createElement("button");
    help.slot = "strip";
    help.dataset.panel = "host-help";
    builder.append(sources, help);
    await until(() => sources.hasAttribute("data-out-of-workspace"));
    expect(help.hasAttribute("data-out-of-workspace")).toBe(false);
    tab(element, "data").click();
    expect(sources.hasAttribute("data-out-of-workspace")).toBe(false);
    expect(help.hasAttribute("data-out-of-workspace")).toBe(false);
  });

  it("keeps the document's label and the file menu on the bar, and the language in Settings, at every width, each its own control", async () => {
    const element = await mount((el) => el.setAttribute("file-actions", ""));
    const builder = element.builder!;
    const root = shell(element);
    const onTheBar = (): void => {
      // No overflow menu gathers them any more.
      for (const gone of ["[data-overflow]", "[data-overflow-toggle]", "[data-overflow-menu]"]) expect(root.querySelector(gone), gone).toBeNull();
      const centre = root.querySelector<HTMLElement>("[data-bar-centre]")!;
      const documents = centre.querySelector<HTMLElement>("[data-documents]")!;
      expect(documents.hidden).toBe(false);
      // The language moved off the bar into the Settings panel.
      expect(root.querySelector('[data-shell="bar"] [data-locale-select]')).toBeNull();
      expect(root.querySelector("[data-settings-panel] [data-settings-language] [data-locale-select]")).not.toBeNull();
      // The file menu is the last thing at the bar's end, its toggle on show.
      const files = root.querySelector<HTMLElement>(".bar-end > [data-file-actions]")!;
      expect(files.parentElement!.lastElementChild).toBe(files);
      expect(files.hidden).toBe(false);
      const toggle = files.querySelector<HTMLElement>("[data-file-menu]")!;
      expect(toggle.hidden).toBe(false);
      // One control on the bar for them all: the menu's button.
      expect(files.querySelectorAll(".bar-btn:not([hidden]):not([data-file-error-dismiss])").length).toBe(1);
      expect(files.querySelectorAll("[role=menuitem]:not([hidden])").length).toBeGreaterThan(0);
    };
    await until(() => !root.querySelector<HTMLElement>("[data-file-actions]")!.hidden);
    onTheBar();

    // Narrow, too: nothing moves off the bar.
    const wrap = root.querySelector<HTMLElement>('[data-shell="wrap"]')!;
    wrap.getBoundingClientRect = () => ({ width: 600, height: 700, x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 700, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(builder.narrowLayout).toBe(true);
    onTheBar();

    // The language select (in Settings) is the form's own: picking one moves the form's locale.
    const select = root.querySelector("[data-settings-panel] [data-locale-select]")!.shadowRoot!.querySelector<HTMLSelectElement>("select")!;
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => builder.controller.currentLocale() === "fr-CA");
  });

  it("forwards a host's strip items, panels and the named bar places through <datum-form-builder>", async () => {
    const element = await mount();
    const launcher = document.createElement("button");
    launcher.slot = "strip";
    launcher.dataset.panel = "sources";
    launcher.dataset.workspace = "data";
    launcher.setAttribute("aria-label", "Data sources");
    const panel = document.createElement("section");
    panel.slot = "panel";
    panel.dataset.panel = "sources";
    panel.textContent = "Your data sources";
    const publish = document.createElement("button");
    publish.slot = "publish";
    publish.textContent = "Publish";
    element.append(launcher, panel, publish);
    // The publish place is on the bar, reached through the wrapper's forwarded slot.
    const publishSlot = shell(element).querySelector<HTMLSlotElement>('slot[name="publish"]')!;
    await until(() => publishSlot.assignedElements({ flatten: true }).includes(publish));
    // The strip item follows the workspace it names, through the forwarded slot.
    await until(() => launcher.hasAttribute("data-out-of-workspace"));
    tab(element, "data").click();
    expect(launcher.hasAttribute("data-out-of-workspace")).toBe(false);
    launcher.click();
    expect(element.builder!.panel).toBe("sources");
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute("aria-selected")).toBe("true");
  });

  it("knows whether the form changed since it was loaded or last saved", async () => {
    const element = await mount();
    const changes: boolean[] = [];
    element.addEventListener("datum-builder-dirty-change", (event) => changes.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));
    await until(() => element.builder?.controller);
    expect(element.dirty).toBe(false);
    element.builder!.controller.add("text");
    await until(() => element.dirty);
    expect(element.hasAttribute("dirty")).toBe(true);
    element.markSaved();
    expect(element.dirty).toBe(false);
    expect(element.hasAttribute("dirty")).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("counts problems on the workspace tabs: the form's data-key clashes on Data, a reported count elsewhere", async () => {
    const element = await mount((el) => {
      const definition = sampleDefinition();
      // Two answers stored at one key: a clash the Data tab counts.
      const content = definition.root.children!.content!;
      (content[0]!.configuration as Record<string, unknown>).dataKey = "same";
      (content[1]!.configuration as Record<string, unknown>).dataKey = "same";
      el.definition = definition;
    });
    const data = tab(element, "data");
    await until(() => data.querySelector(".workspace-count"));
    expect(Number(data.querySelector(".workspace-count")!.textContent)).toBeGreaterThan(0);
    expect(data.getAttribute("aria-label")).toMatch(/^Data, \d+ problems?$/);
    expect(data.querySelector(".workspace-count")!.getAttribute("aria-hidden")).toBe("true");

    element.builder!.workspaceProblems = { journeys: 2, pdf: 1 };
    expect(tab(element, "journeys").querySelector(".workspace-count")!.textContent).toBe("2");
    expect(tab(element, "journeys").getAttribute("aria-label")).toBe("Journeys, 2 problems");
    expect(tab(element, "pdf").getAttribute("aria-label")).toBe("PDF, 1 problem");
    element.builder!.workspaceProblems = {};
    expect(tab(element, "journeys").querySelector(".workspace-count")).toBeNull();
    expect(tab(element, "journeys").hasAttribute("aria-label")).toBe(false);
  });

  it("moves to a form workspace that offers a panel set from outside", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "variables";
    expect(builder.workspace).toBe("logic");
    expect(builder.panel).toBe("variables");
    // The Header and footer panel is Form's alone.
    builder.panel = "chrome";
    expect(builder.workspace).toBe("form");
    expect(builder.panel).toBe("chrome");
  });

  it("keeps one drawer beside the canvas at the medium tier: the inspector and the palette take turns", async () => {
    const element = await mount((el) => el.setAttribute("persist-panels", "ws-t"));
    const builder = element.builder!;
    const wrap = shell(element).querySelector<HTMLElement>('[data-shell="wrap"]')!;
    wrap.getBoundingClientRect = () => ({ width: 1000, height: 700, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 700, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(builder.narrowLayout).toBe(false);
    const props = shell(element).querySelector("datum-builder-properties") as HTMLElement & { collapsed: boolean };
    builder.panel = undefined;
    props.collapsed = false;
    builder.panel = "components";
    builder.controller.select("email");
    // A selection brings the inspector up and sends the palette away.
    expect(props.collapsed).toBe(false);
    expect(builder.panel).toBeUndefined();
    // The palette opening puts the inspector away.
    builder.panel = "components";
    expect(builder.panel).toBe("components");
    expect(props.collapsed).toBe(true);
    // Closing it gives the inspector back.
    builder.panel = undefined;
    expect(props.collapsed).toBe(false);
    // Opening the inspector from its stub closes the palette.
    builder.panel = "components";
    props.collapsed = false;
    props.dispatchEvent(new CustomEvent("panel-toggle", { bubbles: true, composed: true }));
    await until(() => builder.panel === undefined);
    expect(props.collapsed).toBe(false);
    // None of it reached panel memory: the palette stays remembered as the author left it.
    expect(readPanelMemory("ws-t")?.propsCollapsed ?? false).toBe(false);
    // Wide: both stay open.
    wrap.getBoundingClientRect = () => ({ width: 1400, height: 700, x: 0, y: 0, top: 0, left: 0, right: 1400, bottom: 700, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    builder.panel = "components";
    expect(props.collapsed).toBe(false);
    expect(builder.panel).toBe("components");
  });
});
