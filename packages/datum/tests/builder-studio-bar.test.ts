import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The bar's document label (its language in Settings), the strip's show-hidden toggle, an overview's bare
 * entry, the empty canvas's click and the canvas's zoom.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => shell(element)?.querySelector("[data-document-face]") && canvas(element)?.querySelector(".canvas-page"));
  return element;
}

describe("the bar's document label", () => {
  it("names the form and its kind, with no overflow menu, and leaves the language to Settings", async () => {
    const element = await mount();
    const face = shell(element).querySelector<HTMLElement>("[data-document-face]")!;
    expect(face.querySelector("[data-document-picker-name]")!.textContent).toBe("Sample");
    expect(face.querySelector("[data-document-kind]")!.textContent).toBe("Form");
    // The form has no options of its own: a label, not a button.
    expect(face.tagName).toBe("SPAN");
    const centre = shell(element).querySelector("[data-bar-centre]")!;
    expect(centre.contains(face)).toBe(true);
    // The language is no longer beside it: the switcher is in the Settings panel.
    expect(centre.querySelector("[data-locale-select]")).toBeNull();
    expect(shell(element).querySelector('[data-shell="bar"] [data-locale-select]')).toBeNull();
    const select = shell(element).querySelector<HTMLElement>("[data-settings-panel] [data-settings-language] [data-locale-select]");
    expect(select).not.toBeNull();
    expect(select!.getAttribute("label")).toBe("Show the form in");
    for (const gone of ["[data-overflow]", "[data-document-add]", "[data-document-list]", "[data-document-picker]"]) {
      expect(shell(element).querySelector(gone), gone).toBeNull();
    }
  });
});

describe("the strip in Form", () => {
  it("leaves the Components tab to the designers and shows hidden components unless View's switch turns them off", async () => {
    const element = await mount();
    const root = shell(element);
    expect(root.querySelector('[data-strip] [data-panel="components"]')!.hasAttribute("data-out-of-workspace")).toBe(true);
    // Back on the View panel, and on by default.
    expect(root.querySelector("[data-strip-card] [data-show-hidden]")).toBeNull();
    const toggle = root.querySelector<HTMLInputElement>("[data-view-panel] [data-show-hidden]")!;
    expect(toggle.checked).toBe(true);
    expect(element.builder!.controller.showHiddenComponents()).toBe(true);
    toggle.click();
    expect(element.builder!.controller.showHiddenComponents()).toBe(false);
  });

  it("brings Form back when the palette is asked for from Logic, its rail's All components pressed", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.setWorkspace("logic");
    builder.panel = "components";
    expect(builder.workspace).toBe("form");
    expect(builder.panel).toBe("components");
    await until(() => shell(element).querySelector('[data-rail-more][aria-pressed="true"]'));
  });
});

describe("the Journeys and PDF overviews", () => {
  it("hide the rails and open the Form tab from them with no panel chosen", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "outline";
    builder.setWorkspace("pdf");
    await until(() => shell(element).querySelector("datum-builder-overview")?.shadowRoot?.querySelector('[data-overview-add="pdf"]'));
    expect(shell(element).querySelector("[data-shell=wrap]")!.hasAttribute("data-overview")).toBe(true);
    expect(builder.panel).toBeUndefined();

    builder.setWorkspace("form");
    expect(builder.workspace).toBe("form");
    expect(builder.panel).toBeUndefined();
    expect(shell(element).querySelector("[data-shell=wrap]")!.hasAttribute("data-overview")).toBe(false);
  });
});

describe("a click on empty canvas", () => {
  it("puts the selection and the side panel down, asking first about unsaved edits", async () => {
    const element = await mount();
    const builder = element.builder!;
    const controller = builder.controller;
    builder.panel = "outline";
    controller.select("fullName");
    controller.setDraftProperty("fullName", "placeholder", "Your name");

    canvas(element).querySelector<HTMLElement>(".canvas-page")!.click();
    // Held behind the prompt: nothing goes yet.
    expect(controller.unsavedChangesPrompt()).toBeDefined();
    expect(controller.selectedComponentId()).toBe("fullName");
    expect(builder.panel).toBe("outline");

    controller.answerUnsavedChangesPrompt("discard");
    expect(controller.selectedComponentId()).toBeUndefined();
    expect(builder.panel).toBeUndefined();
  });

  it("keeps a click on a component a selection, the panel left open", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "outline";
    const preview = canvas(element).querySelector("[data-preview]")!.shadowRoot!;
    // The canvas's node (`.db-node`), inside the renderer's field wrapper that carries the same id.
    await until(() => preview.querySelector('.db-node[data-component-id="country"]'));
    preview.querySelector<HTMLElement>('.db-node[data-component-id="country"]')!.click();
    expect(builder.controller.selectedComponentId()).toBe("country");
    expect(builder.panel).toBe("outline");
  });
});

describe("the canvas's zoom", () => {
  it("steps the sheet out and in from the bar and the keys, holds at the ends, and goes back to 100%", async () => {
    const element = await mount();
    const root = canvas(element);
    const surface = root.querySelector<HTMLElement>(".canvas-surface")!;
    const level = (): string => root.querySelector("[data-canvas-zoom-level]")!.textContent!;
    const go = (where: string): void => root.querySelector<HTMLButtonElement>(`[data-canvas-zoom-go="${where}"]`)!.click();

    expect(level()).toBe("100%");
    go("out");
    expect(surface.style.zoom).toBe("0.8");
    expect(level()).toBe("80%");
    expect(root.querySelector("[data-canvas-announce]")!.textContent).toBe("Zoom 80%");

    const page = root.querySelector<HTMLElement>(".canvas-page")!;
    page.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true, composed: true }));
    expect(level()).toBe("100%");
    expect(surface.style.zoom).toBe("");

    for (let step = 0; step < 10; step += 1) {
      go("out");
    }
    expect(level()).toBe("25%");
    expect(root.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="out"]')!.disabled).toBe(true);

    go("actual");
    expect(level()).toBe("100%");
    expect(root.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="out"]')!.disabled).toBe(false);
  });
});

describe("the Settings panel's data sources", () => {
  it("lists the sources the form's choices name, simulates one from lines of value | label, and stops", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "settings";
    const list = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-settings-sources]")!;
    await until(() => list().querySelector('[data-source-id="countries"]'));
    const row = (): HTMLElement => list().querySelector<HTMLElement>('[data-source-id="countries"]')!;
    expect(row().querySelector(".source-state")!.textContent).toBe("Not provided");

    row().querySelector<HTMLButtonElement>("[data-source-edit]")!.click();
    const box = row().querySelector<HTMLTextAreaElement>("[data-source-text]")!;
    box.value = "ca | Canada\nmx | Mexico\nus";
    row().querySelector<HTMLButtonElement>("[data-source-apply]")!.click();
    expect([...builder.controller.simulatedDataSources().get("countries")!]).toEqual([
      { value: "ca", label: "Canada" },
      { value: "mx", label: "Mexico" },
      { value: "us", label: "us" }
    ]);
    expect(row().querySelector(".source-state")!.textContent).toBe("Simulated");
    // The canvas previews with the list: the select's options load from it.
    const result = await builder.controller.dataSources()!.load("countries");
    expect(result.items.map((item) => item.value)).toEqual(["ca", "mx", "us"]);
    // The definition never holds it.
    expect(JSON.stringify(element.definition)).not.toContain("Mexico");

    row().querySelector<HTMLButtonElement>("[data-source-clear]")!.click();
    expect(builder.controller.simulatedDataSources().has("countries")).toBe(false);
    expect(row().querySelector(".source-state")!.textContent).toBe("Not provided");
  });

  it("takes LocalizedText labels in a JSON list and keeps them through an edit", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "settings";
    const list = shell(element).querySelector<HTMLElement>("[data-settings-sources]")!;
    await until(() => list.querySelector('[data-source-id="countries"] [data-source-edit]'));
    const row = (): HTMLElement => list.querySelector<HTMLElement>('[data-source-id="countries"]')!;
    row().querySelector<HTMLButtonElement>("[data-source-edit]")!.click();
    row().querySelector<HTMLTextAreaElement>("[data-source-text]")!.value =
      '[{"value":"ca","label":{"default":"Canada","locales":{"fr":"Canada (fr)"}}},{"value":"us","label":"United States"}]';
    row().querySelector<HTMLButtonElement>("[data-source-apply]")!.click();
    expect([...builder.controller.simulatedDataSources().get("countries")!]).toEqual([
      { value: "ca", label: { default: "Canada", locales: { fr: "Canada (fr)" } } },
      { value: "us", label: "United States" }
    ]);
    row().querySelector<HTMLButtonElement>("[data-source-edit]")!.click();
    expect(JSON.parse(row().querySelector<HTMLTextAreaElement>("[data-source-text]")!.value)[0].label.locales.fr).toBe("Canada (fr)");
  });

  it("says why a list cannot be read, and keeps the box open", async () => {
    const element = await mount();
    element.builder!.panel = "settings";
    const list = shell(element).querySelector<HTMLElement>("[data-settings-sources]")!;
    await until(() => list.querySelector('[data-source-id="countries"] [data-source-edit]'));
    list.querySelector<HTMLButtonElement>('[data-source-id="countries"] [data-source-edit]')!.click();
    list.querySelector<HTMLTextAreaElement>("[data-source-text]")!.value = '[{"label": "No value"}]';
    list.querySelector<HTMLButtonElement>("[data-source-apply]")!.click();
    expect(list.querySelector('[role="alert"]')!.textContent).toBe("Each entry needs a value.");
    expect(list.querySelector("[data-source-text]")).not.toBeNull();
  });
});

describe("the View panel's form chrome", () => {
  it("previews the form under the page's frame, fixed or not, and its header and footer left out", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "view";
    const root = shell(element);
    const frame = root.querySelector<HTMLSelectElement>("[data-preview-chrome-frame]")!;
    expect(frame.value).toBe("");
    expect([...frame.options].map((option) => option.value)).toContain("paper");
    frame.value = "paper";
    frame.dispatchEvent(new Event("change", { bubbles: true }));
    expect(builder.controller.previewChrome()).toEqual({ frame: "paper" });
    const fixed = root.querySelector<HTMLInputElement>("[data-preview-chrome-fixed]")!;
    fixed.checked = true;
    fixed.dispatchEvent(new Event("change", { bubbles: true }));
    const parts = root.querySelector<HTMLInputElement>("[data-preview-chrome-parts]")!;
    parts.checked = false;
    parts.dispatchEvent(new Event("change", { bubbles: true }));
    expect(builder.controller.previewChrome()).toEqual({ frame: { id: "paper", fixed: true }, formChrome: "exclude" });
    frame.value = "";
    frame.dispatchEvent(new Event("change", { bubbles: true }));
    parts.checked = true;
    parts.dispatchEvent(new Event("change", { bubbles: true }));
    expect(builder.controller.previewChrome()).toBeUndefined();
  });
});

describe("leaving a panel that edits the form", () => {
  it("asks about the Form panel's unapplied edits before another panel opens, and opens it once answered", async () => {
    const element = await mount();
    const builder = element.builder!;
    const controller = builder.controller;
    builder.panel = "form";
    controller.setDraftProperty(controller.rootId(), "title", "Renamed");
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="chrome"]')!.click();
    expect(controller.unsavedChangesPrompt()).toBeDefined();
    expect(builder.panel).toBe("form");
    controller.answerUnsavedChangesPrompt("discard");
    expect(builder.panel).toBe("chrome");
    expect(controller.hasPendingChanges(controller.rootId())).toBe(false);
  });

  it("opens the next panel at once when nothing is waiting", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.panel = "form";
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="outline"]')!.click();
    expect(builder.panel).toBe("outline");
  });
});

describe("Try it's panel", () => {
  async function trying(): Promise<{ element: DatumFormBuilderElement; panel: HTMLElement }> {
    const element = await mount();
    const canvasEl = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
    canvasEl.previewing = true;
    const panel = canvas(element).querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => !panel.hidden && panel.querySelector("[data-try-check]"));
    return { element, panel };
  }

  it("shows while previewing: the form filled in or read only, and the answers as a submission carries them", async () => {
    const { element, panel } = await trying();
    const renderer = canvas(element).querySelector("[data-preview]") as HTMLElement & { mode: string };
    expect(renderer.mode).toBe("interactive");
    panel.querySelector<HTMLButtonElement>('[data-try-mode="readonly"]')!.click();
    expect(renderer.mode).toBe("readonly");
    expect(panel.querySelector('[data-try-mode="readonly"]')!.getAttribute("aria-checked")).toBe("true");
    expect(panel.querySelector("[data-try-data]")!.textContent).toBe("{}");
    // <datum-form-builder> lends Try it its PDF side's support, loaded on the first Preview PDF.
    // WebAssembly validation is always a part of Checks, off until the author turns it on.
    expect(panel.querySelector("[data-try-pdf]")).not.toBeNull();
    expect(panel.querySelector<HTMLInputElement>("[data-try-server]")!.checked).toBe(false);
    element.setAttribute("features", "-pdf");
    await until(() => panel.querySelector("[data-try-pdf]") === null);

    const canvasEl = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
    canvasEl.previewing = false;
    expect(panel.hidden).toBe(true);
    expect(renderer.mode).toBe("interactive");
  });

  it("checks the answers in the browser, naming the field and the form's wording, and the server's when lent", async () => {
    const { element, panel } = await trying();
    panel.querySelector<HTMLButtonElement>("[data-try-check]")!.click();
    await until(() => panel.querySelector(".try-problem"));
    const problem = panel.querySelector<HTMLElement>(".try-problem")!;
    expect(problem.dataset.tryGoto).toBe("fullName");
    expect(problem.querySelector("strong")!.textContent).toBe("Full name");

    let asked: Record<string, unknown> | undefined;
    element.builder!.serverChecks = {
      label: "Test sandbox",
      run: async ({ answers }) => {
        asked = answers;
        return { errors: [{ code: "required", componentId: "country", stage: "kernel", source: "wasm" }] };
      }
    };
    const server = (): HTMLInputElement => panel.querySelector<HTMLInputElement>("[data-try-server]")!;
    // The page's checks in hand: named once ready.
    expect(panel.querySelector("[data-try-wasm-status]")!.textContent).toBe("Ready: Test sandbox.");
    server().click();
    await until(() => [...panel.querySelectorAll(".try-subtitle")].some((title) => title.textContent === "On the server") && !panel.textContent!.includes("Checking…"));
    expect(asked).toEqual({});
    expect([...panel.querySelectorAll<HTMLElement>(".try-problem")].map((entry) => entry.dataset.tryGoto)).toContain("country");
  });
});

describe("a mode's bar actions", () => {
  it("sit in the canvas's toolbar, the primary one the accent pill before Try it, and leave the bar's group empty", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = {
      ...sampleDefinition(),
      pdf: {
        defaultLayoutId: "letter",
        layouts: [{ id: "letter", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } }]
      }
    } as ReturnType<typeof sampleDefinition>;
    document.body.append(element);
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    const group = shell(element).querySelector("[data-mode-actions]")!;
    expect(group.classList.contains("bar-group")).toBe(true);
    // The top bar is navigation: the PDF mode has no views switch, so nothing of its is there.
    expect(group.querySelectorAll("button").length).toBe(0);
    const bar = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLElement>("[data-canvas-bar]")!;
    const preview = bar.querySelector<HTMLElement>("[data-preview-pdf]")!;
    expect(preview.classList.contains("canvas-try")).toBe(true);
    expect(preview.nextElementSibling).toBe(bar.querySelector("[data-try-it]"));
    for (const button of bar.querySelectorAll("[data-canvas-actions] > button")) {
      expect(button.classList.contains("canvas-tool")).toBe(true);
      expect(button.classList.contains("canvas-word")).toBe(true);
    }
    expect(bar.querySelectorAll("[data-canvas-actions] > button").length).toBe(2);
  });
});

describe("the bar's document pill at narrow widths", () => {
  it("keeps a floor on the pill and names the document in a title for when the text is cut", async () => {
    const element = await mount();
    const face = shell(element).querySelector<HTMLElement>("[data-document-face]")!;
    expect(face.querySelector("[data-document-picker-name]")!.getAttribute("title")).toBe("Sample");
    const css = [...shell(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/\.documents \{[^}]*min-width: min\(10rem, 100%\)/);
    expect(css).toMatch(/\.document-face-name \{ min-width: 6ch/);
  });
});
