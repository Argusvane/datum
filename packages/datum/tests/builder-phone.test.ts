import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, PdfGeneratedLayout, PdfRenderProvider } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The phone tier: under 768px of its own box the shell
 * has one top row, a bottom bar, bottom sheets and a menu drawer. jsdom lays nothing out and evaluates no container query, so
 * these cases read the attributes and the semantics the CSS keys on; the look is the harness's
 * (npm run builder:browser, the phone sizes).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => shell(element).querySelector<T>(selector)!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => q(element, "[data-shell=wrap]");
const canvasEl = (element: DatumFormBuilderElement) => q(element, "datum-builder-canvas") as HTMLElement & { previewing: boolean };
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const properties = (element: DatumFormBuilderElement) => q(element, "datum-builder-properties") as HTMLElement & { collapsed: boolean };
const form = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector<HTMLElement>("datum-form-renderer[data-preview]")!.shadowRoot!;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
};
/** The bottom bar's items on show, in the order the phone lays them out. */
const bottomBar = (element: DatumFormBuilderElement): string[] =>
  [...shell(element).querySelectorAll<HTMLElement>("[data-rail-more], [data-strip] [data-panel], [data-bottom-try], [data-bottom-results], [data-bottom-more]")]
    .filter((item) => !item.hidden && !item.hasAttribute("data-out-of-workspace") && !item.hasAttribute("data-bottom-overflow") && item.style.order !== "")
    .sort((a, b) => Number(a.style.order) - Number(b.style.order))
    .map((item) => item.dataset.panel ?? (item.dataset.railMore !== undefined ? "add" : item.dataset.bottomTry !== undefined ? "try" : item.dataset.bottomResults !== undefined ? "results" : "more"));

/** Pretends the shell's wrap is `width` px wide, the way a real layout would, and tells the shell. */
function resizeTo(element: DatumFormBuilderElement, width: number): void {
  wrap(element).getBoundingClientRect = () => ({ width, height: 844, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 844, toJSON: () => ({}) }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => form(element)?.querySelector('[data-component-id="fullName"]'));
  await settle();
  resizeTo(element, 390);
  return element;
}

describe("the phone tier", () => {
  it("comes on under 768px of the shell's own box, tells the parts, and goes again", async () => {
    const element = await mount();
    const builder = element.builder!;
    expect(builder.phoneLayout).toBe(true);
    expect(builder.narrowLayout).toBe(true);
    expect(wrap(element).hasAttribute("data-phone")).toBe(true);
    expect(canvasEl(element).hasAttribute("data-phone")).toBe(true);
    // The inspector is a sheet with a frame of its own, not floating cards.
    expect(properties(element).hasAttribute("data-phone")).toBe(true);
    expect(properties(element).hasAttribute("data-floating")).toBe(false);

    resizeTo(element, 800);
    expect(builder.phoneLayout).toBe(false);
    expect(builder.narrowLayout).toBe(true);
    expect(wrap(element).hasAttribute("data-phone")).toBe(false);
    expect(canvasEl(element).hasAttribute("data-phone")).toBe(false);
    expect(properties(element).hasAttribute("data-floating")).toBe(true);
    // The bottom bar's own buttons are gone with it.
    expect(q(element, "[data-bottom-try]").hidden).toBe(true);
    expect(q(element, "[data-bottom-more]").hidden).toBe(true);
  });

  it("names the Menu button by the workspace and its problems", async () => {
    const element = await mount();
    const menu = q(element, "[data-menu-open]");
    expect(q(element, "[data-menu-open-label]").textContent).toBe("Form");
    expect(menu.getAttribute("aria-label")).toBe("Menu. Form workspace");
    element.builder!.workspaceProblems = { form: 2 };
    expect(q(element, "[data-menu-open-count]").hidden).toBe(false);
    expect(q(element, "[data-menu-open-count]").textContent).toBe("2");
    expect(menu.getAttribute("aria-label")).toBe("Menu. Form workspace, 2 problems");
    element.builder!.setWorkspace("logic");
    expect(q(element, "[data-menu-open-label]").textContent).toBe("Logic");
  });

  it("lays the strip and the rail flat: four items at most, the rest behind More", async () => {
    const element = await mount();
    expect(bottomBar(element)).toEqual(["add", "outline", "try", "more"]);
    // What does not fit is marked, so the phone's CSS puts it away.
    for (const panel of ["form", "chrome", "view", "settings"]) {
      expect(q(element, `[data-strip] [data-panel="${panel}"]`).hasAttribute("data-bottom-overflow")).toBe(true);
    }
    // The rail's button says what it shows here, and is the rail's one Tab stop.
    expect(q(element, "[data-rail-more]").getAttribute("aria-label")).toBe("Add a component");
    expect(q(element, "[data-rail-more]").tabIndex).toBe(0);
    expect([...shell(element).querySelectorAll<HTMLElement>("[data-rail-add]")].every((button) => button.tabIndex === -1)).toBe(true);

    element.builder!.setWorkspace("logic");
    expect(bottomBar(element)).toEqual(["outline", "variables", "settings", "tests"]);
    expect(q(element, "[data-bottom-try]").hidden).toBe(true);
    element.builder!.setWorkspace("data");
    expect(bottomBar(element)).toEqual(["variables", "settings", "tests"]);

    // Off the phone every mark comes off.
    element.builder!.setWorkspace("form");
    resizeTo(element, 1200);
    expect(shell(element).querySelectorAll("[data-bottom-overflow]").length).toBe(0);
    expect(q(element, "[data-rail-more]").getAttribute("aria-label")).toBe("All components");
  });

  it("opens More as a dialog of the items past four; a row opens its panel as a sheet, the rest inert", async () => {
    const element = await mount();
    const more = q<HTMLButtonElement>(element, "[data-bottom-more]");
    more.focus();
    more.click();
    expect(wrap(element).dataset.sheet).toBe("more");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const rows = [...shell(element).querySelectorAll<HTMLElement>("[data-more-list] [data-more-go]")];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(["Form settings", "Header and footer", "View", "Settings", "Tests"]);
    expect(q(element, "[data-shell=bar]").hasAttribute("inert")).toBe(true);

    rows[2]!.click();
    expect(element.builder!.panel).toBe("view");
    expect(wrap(element).dataset.sheet).toBe("side");
    const side = q(element, "[data-side]");
    expect(side.getAttribute("role")).toBe("dialog");
    expect(side.getAttribute("aria-modal")).toBe("true");
    expect(side.getAttribute("aria-label")).toBe("View");
    expect(q(element, "[data-sheet-head]").hidden).toBe(false);
    for (const behind of [q(element, "[data-shell=bar]"), q(element, "[data-rails]"), canvasEl(element)]) {
      expect(behind.hasAttribute("inert")).toBe(true);
    }

    // Escape puts it away: nothing inert, the column a tab panel again, focus back on More.
    press(side, "Escape");
    expect(element.builder!.panel).toBeUndefined();
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(side.getAttribute("role")).toBe("tabpanel");
    expect(shell(element).querySelectorAll("[inert]").length).toBe(0);
    expect(shell(element).activeElement).toBe(more);
  });

  it("makes a sheet tall from its handle and closes it from its close button", async () => {
    const element = await mount();
    q(element, "[data-strip] [data-panel=\"outline\"]").click();
    expect(wrap(element).dataset.sheet).toBe("side");
    const grab = q(element, "[data-sheet-grab]");
    expect(grab.getAttribute("aria-expanded")).toBe("false");
    grab.click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
    expect(grab.getAttribute("aria-label")).toBe("Drag to close or tap to shrink");
    q(element, "[data-sheet-close]").click();
    expect(element.builder!.panel).toBeUndefined();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(false);
    // The height is remembered for the panel, for this page.
    q(element, "[data-strip] [data-panel=\"outline\"]").click();
    expect(wrap(element).hasAttribute("data-sheet-tall")).toBe(true);
  });

  it("never opens the inspector on a selection: Edit, a second tap and Enter do", async () => {
    const element = await mount();
    const controller = element.builder!.activeController;
    controller.select("fullName");
    await settle();
    expect(properties(element).collapsed).toBe(true);
    expect(wrap(element).dataset.sheet).toBeUndefined();

    const edit = canvas(element).querySelector<HTMLButtonElement>("[data-selection-edit]")!;
    expect(edit.hidden).toBe(false);
    expect(edit.getAttribute("aria-label")).toBe("Edit Full name");
    edit.click();
    expect(properties(element).collapsed).toBe(false);
    expect(wrap(element).dataset.sheet).toBe("props");
    expect(properties(element).getAttribute("role")).toBe("dialog");
    expect(canvasEl(element).hasAttribute("inert")).toBe(true);

    q(element, "[data-sheet-close]").click();
    expect(properties(element).collapsed).toBe(true);
    expect(properties(element).hasAttribute("role")).toBe(false);
    expect(canvasEl(element).hasAttribute("inert")).toBe(false);

    // A tap on the component already selected opens its settings.
    // The canvas's node (`.db-node`), inside the renderer's field wrapper that carries the same id.
    form(element).querySelector<HTMLElement>('.db-node[data-component-id="fullName"]')!.click();
    expect(wrap(element).dataset.sheet).toBe("props");
  });

  it("keeps Edit off the selection bar at other widths", async () => {
    const element = await mount();
    resizeTo(element, 1200);
    element.builder!.activeController.select("fullName");
    await settle();
    expect(canvas(element).querySelector<HTMLButtonElement>("[data-selection-edit]")!.hidden).toBe(true);
  });

  it("puts the Components and Outline sheets away once a component is picked", async () => {
    const element = await mount();
    q(element, "[data-strip] [data-panel=\"outline\"]").click();
    expect(element.builder!.panel).toBe("outline");
    element.builder!.activeController.select("country");
    expect(element.builder!.panel).toBeUndefined();
  });

  it("opens the menu drawer with the workspaces, the canvas, the file actions and the tools", async () => {
    const element = await mount((el) => {
      el.fileActions = { save: () => undefined, download: () => ({ name: "form.json", text: "{}" }) };
    });
    const menu = q(element, "[data-menu-open]");
    menu.focus();
    menu.click();
    const drawer = q(element, "[data-menu-drawer]");
    expect(drawer.hidden).toBe(false);
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(wrap(element).dataset.sheet).toBe("menu");
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(q(element, "[data-menu-title]").textContent).toBe("Sample");
    const go = [...drawer.querySelectorAll<HTMLElement>("[data-menu-go]")].map((row) => row.dataset.menuGo);
    expect(go).toEqual(expect.arrayContaining(["workspace:form", "workspace:logic", "try", "show-hidden", "file:save", "file:download", "search"]));
    expect(drawer.querySelector('[data-menu-go="workspace:form"]')!.getAttribute("aria-current")).toBe("true");
    expect(q(element, "[data-shell=bar]").hasAttribute("inert")).toBe(true);
    expect(q(element, ".body").hasAttribute("inert")).toBe(true);

    // A switch keeps the drawer up and says its state.
    const before = element.builder!.activeController.showHiddenComponents();
    drawer.querySelector<HTMLElement>('[data-menu-go="show-hidden"]')!.click();
    expect(element.builder!.activeController.showHiddenComponents()).toBe(!before);
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelector('[data-menu-go="show-hidden"]')!.getAttribute("aria-checked")).toBe(String(!before));

    // A workspace row puts the drawer away and switches.
    drawer.querySelector<HTMLElement>('[data-menu-go="workspace:data"]')!.click();
    expect(drawer.hidden).toBe(true);
    expect(element.builder!.workspace).toBe("data");
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(shell(element).activeElement).toBe(menu);
  });

  it("says in the drawer whether the form is saved", async () => {
    const element = await mount();
    q(element, "[data-menu-open]").click();
    expect(q(element, "[data-menu-state]").textContent).toBe("All changes saved");
    q(element, "[data-menu-close]").click();
    element.builder!.activeController.select("fullName");
    element.builder!.activeController.setProperty("fullName", "label", "Your name");
    element.builder!.activeController.commitDraft("fullName");
    await until(() => element.dirty);
    q(element, "[data-menu-open]").click();
    expect(q(element, "[data-menu-state]").textContent).toBe("Changes not saved");
  });

  it("moves the host's bar controls into the drawer, and back when the shell widens", async () => {
    const element = await mount((el) => {
      const publish = document.createElement("button");
      publish.slot = "publish";
      publish.textContent = "Publish";
      el.append(publish);
    });
    const host = q(element, "[data-menu-host]");
    expect(host.querySelector('slot[name="publish"]')).not.toBeNull();
    q(element, "[data-menu-open]").click();
    expect(q(element, "[data-menu-host-section]").hidden).toBe(false);
    q(element, "[data-menu-close]").click();
    resizeTo(element, 1200);
    expect(host.querySelector('slot[name="publish"]')).toBeNull();
    expect(q(element, '.bar-end slot[name="publish"]')).not.toBeNull();
  });

  it("puts Try it on the bottom bar and its results in a sheet, Results in More's place", async () => {
    const element = await mount();
    q(element, "[data-bottom-try]").click();
    expect(canvasEl(element).previewing).toBe(true);
    expect(q(element, "[data-bottom-try]").getAttribute("aria-pressed")).toBe("true");
    expect(bottomBar(element)).toEqual(["add", "outline", "try", "results"]);
    expect(q<HTMLButtonElement>(element, "[data-rail-more]").disabled).toBe(true);

    q(element, "[data-bottom-results]").click();
    expect(canvasEl(element).hasAttribute("data-results-open")).toBe(true);
    expect(wrap(element).dataset.sheet).toBe("results");
    // The sheet's head is there before the chunk's cards, so it can always be closed.
    expect(canvas(element).querySelector("[data-try-panel] [data-try-close]")).not.toBeNull();
    // Try it's cards come with its chunk.
    await until(() => canvas(element).querySelector("[data-try-panel] .try-card"));
    canvas(element).querySelector<HTMLElement>("[data-try-close]")!.click();
    expect(canvasEl(element).hasAttribute("data-results-open")).toBe(false);
    expect(wrap(element).dataset.sheet).toBeUndefined();

    // Back to editing takes the results with it.
    q(element, "[data-bottom-results]").click();
    q(element, "[data-bottom-try]").click();
    expect(canvasEl(element).previewing).toBe(false);
    expect(canvasEl(element).hasAttribute("data-results-open")).toBe(false);
    expect(bottomBar(element)).toEqual(["add", "outline", "try", "more"]);
  });

  it("puts Try it on the bottom bar of a PDF layout too, and tries the form there", async () => {
    const layout: PdfGeneratedLayout = {
      id: "letter",
      kind: "generated",
      name: "Letter",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "letter-field", type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] } }
    };
    const provider = {
      id: "fake",
      abiVersion: "4.0.0",
      render: async () => ({ bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
      inspect: async () => ({ pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: [], hasXfa: false, encrypted: false })
    } as unknown as PdfRenderProvider;
    const element = await mount((builder) => {
      builder.definition = { ...sampleDefinition(), pdf: { layouts: [layout] } } as FormDefinition;
      builder.pdfSupport = { provider };
    });
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    await until(() => !q(element, "[data-bottom-try]").hidden);
    await until(() => form(element).querySelector('[data-component-id="letter-field"]'));
    expect(bottomBar(element)).toContain("try");
    q(element, "[data-bottom-try]").click();
    expect(canvasEl(element).previewing).toBe(true);
    expect(q(element, "[data-bottom-try]").getAttribute("aria-pressed")).toBe("true");
    // The form in the layout's place, the layout's tree gone meanwhile.
    await until(() => form(element).querySelector('[data-component-id="fullName"] input'));
    expect(form(element).querySelector('[data-component-id="letter-field"]')).toBeNull();
    q(element, "[data-bottom-try]").click();
    expect(canvasEl(element).previewing).toBe(false);
    await until(() => form(element).querySelector('[data-component-id="letter-field"]'));
    expect(form(element).querySelector('[data-component-id="fullName"] input')).toBeNull();
  });

  it("keeps Record going when the Tests sheet is put away, and finds the line and Stop recording when it is reopened", async () => {
    const tests = { scenarios: [{ id: "test-1", source: 'test "name is kept"\n  given journey = none\n' }] };
    const element = await mount((el) => {
      el.definition = { ...sampleDefinition(), tests };
    });
    const openTests = async (): Promise<HTMLElement> => {
      q(element, "[data-bottom-more]").click();
      const row = [...shell(element).querySelectorAll<HTMLElement>("[data-more-list] [data-more-go]")].find((candidate) => candidate.textContent?.trim() === "Tests")!;
      row.click();
      expect(element.builder!.panel).toBe("tests");
      const panel = q(element, "datum-builder-tests-panel") as HTMLElement & { testsEditorLoader?: () => Promise<never> };
      // jsdom has no layout for CodeMirror: the panel's plain box takes the source.
      panel.testsEditorLoader = () => Promise.reject(new Error("the box, not CodeMirror"));
      await until(() => panel.shadowRoot?.querySelector("[data-tests-entry], [data-tests-record]"));
      return panel;
    };
    const record = (panel: HTMLElement): HTMLElement => panel.shadowRoot!.querySelector<HTMLElement>("[data-tests-record]")!;

    let panel = await openTests();
    panel.shadowRoot!.querySelector<HTMLElement>('[data-tests-entry="test-1"]')!.click();
    await until(() => record(panel) && !record(panel).hasAttribute("disabled"));
    expect(record(panel).textContent).not.toMatch(/stop/i);
    record(panel).click();
    await until(() => (panel as HTMLElement & { recording?: boolean }).recording === true);
    // The bar keeps the way out; the sheet is not what the author fills the form through.
    await until(() => canvas(element).querySelector("[data-try-record-stop]"));
    expect(canvas(element).querySelector("[data-try-record-stop]")!.textContent).toMatch(/stop recording/i);
    if (element.builder!.panel !== undefined) {
      q(element, "[data-sheet-close]").click();
    }
    expect(element.builder!.panel).toBeUndefined();
    expect(wrap(element).dataset.sheet).toBeUndefined();
    // Put away is only hidden: the recording runs on.
    expect((panel as HTMLElement & { recording?: boolean }).recording).toBe(true);

    // An answer on the canvas's runtime, left, is a recorded line.
    const runtime = (canvasEl(element) as unknown as { previewRuntime(): { setValue(id: string, value: unknown): void } | undefined }).previewRuntime();
    runtime!.setValue("fullName", "Ada Lovelace");
    form(element).querySelector<HTMLElement>('[data-component-id="fullName"] input')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    await settle();

    panel = await openTests();
    const written = (): string => {
      const box = panel.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea");
      return box?.value ?? panel.shadowRoot!.querySelector(".cm-content")?.textContent ?? "";
    };
    await until(() => written().includes('set fullName = "Ada Lovelace"'));
    // The label says it (one signal, not a pressed state too): Stop recording where Record was.
    expect(record(panel).textContent).toMatch(/stop recording/i);
  });

  it("dims the bars while a surface's own editor is up as a sheet", async () => {
    const element = await mount();
    canvasEl(element).dispatchEvent(new CustomEvent("builder-sheet-change", { detail: { open: true }, bubbles: true, composed: true }));
    expect(wrap(element).dataset.sheet).toBe("surface");
    expect(q(element, "[data-rails]").hasAttribute("inert")).toBe(true);
    canvasEl(element).dispatchEvent(new CustomEvent("builder-sheet-change", { detail: { open: false }, bubbles: true, composed: true }));
    expect(wrap(element).dataset.sheet).toBeUndefined();
    expect(q(element, "[data-rails]").hasAttribute("inert")).toBe(false);
  });
});
