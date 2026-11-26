import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { clearPanelMemory, readPanelMemory } from "@argusvane/datum-engine";
import type { ComponentNode, DatumBuilderElement, DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/**
 * The shell's first-use behaviour: the Components palette at first paint, the
 * answers tried in Try it going with it, the notice for a form that cannot be submitted,
 * the document face's chips, the File menu holding no publishing line and one name for
 * the preview in the minimal builder. jsdom lays nothing out, so the CSS halves are
 * checked as text and the visual halves go to the browser harness.
 */

afterEach(() => {
  document.body.innerHTML = "";
  for (const key of ["audit-a", "audit-b"]) {
    clearPanelMemory(key);
  }
});

const SEEDED_SUBMIT: ComponentNode = { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } };

function formRoot(content: ComponentNode[], id = "root"): ComponentNode {
  return { id, type: "form", configuration: { title: "Audit" }, children: { content } };
}

const NAME: ComponentNode = { id: "fullName", type: "text", configuration: { label: "Full name" } };

async function mount(root: ComponentNode, setup?: (element: DatumBuilderElement) => void): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: root, componentTypes: [{ type: "text", label: "Text" }, { type: "button", label: "Button" }] };
  setup?.(element);
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector(".canvas-page"));
  return element;
}

const shell = (element: DatumBuilderElement): ShadowRoot => element.shadowRoot!;
const canvasEl = (element: DatumBuilderElement): HTMLElement & { previewing: boolean; previewRuntime(): { state(): { values: Record<string, unknown> } } } =>
  shell(element).querySelector("datum-builder-canvas") as never;
const canvasRoot = (element: DatumBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const strip = (element: DatumBuilderElement, panel: string): HTMLButtonElement => shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;
const toolbar = (element: DatumBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>("datum-builder-toolbar")!;

describe("the Components palette at first paint", () => {
  it("opens on a form with no components and stays shut on one with some", async () => {
    const empty = await mount(formRoot([]));
    expect(empty.panel).toBe("components");
    expect(toolbar(empty).hidden).toBe(false);
    expect(shell(empty).querySelector("[data-rail-more]")!.getAttribute("aria-pressed")).toBe("true");

    const filled = await mount(formRoot([NAME], "other"));
    expect(filled.panel).toBeUndefined();
    expect(toolbar(filled).hidden).toBe(true);
    expect(shell(filled).querySelector("[data-rail-more]")!.getAttribute("aria-pressed")).toBe("false");
    expect(shell(filled).querySelector(".wrap")!.hasAttribute("data-side-collapsed")).toBe(true);
  });

  it("counts the untouched Submit button File > New seeds as no components, but not one the author changed", async () => {
    const seeded = await mount(formRoot([SEEDED_SUBMIT]));
    expect(seeded.panel).toBe("components");
    const renamed = await mount(formRoot([{ ...SEEDED_SUBMIT, configuration: { label: "Send", action: "submit" } }], "other"));
    expect(renamed.panel).toBeUndefined();
    const two = await mount(formRoot([NAME, SEEDED_SUBMIT], "third"));
    expect(two.panel).toBeUndefined();
  });

  it("follows a form put in place: shut for components (File > Open), open for an empty one (File > New)", async () => {
    const element = await mount(formRoot([]));
    expect(element.panel).toBe("components");
    element.options = { initialRoot: formRoot([NAME], "opened") };
    expect(element.panel).toBeUndefined();
    element.options = { initialRoot: formRoot([SEEDED_SUBMIT], "fresh") };
    expect(element.panel).toBe("components");

    // A form that leaves the palette as it is repaints no panel: no panel-change is announced for it.
    const heard: unknown[] = [];
    element.addEventListener("builder-panel-change", (event) => heard.push((event as CustomEvent).detail));
    element.options = { initialRoot: formRoot([], "again") };
    element.options = { initialRoot: formRoot([SEEDED_SUBMIT], "and-again") };
    expect(heard).toEqual([]);
    element.options = { initialRoot: formRoot([NAME], "worked-on") };
    expect(heard).toEqual([{ panel: undefined }]);
  });

  it("leaves the palette alone when only the component definitions are handed again (a plugin registering late)", async () => {
    const element = await mount(formRoot([]));
    expect(element.panel).toBe("components");
    // The author adds a component with the palette up: a rebuild over the same tree must not shut it.
    element.controller.requestAdd("text");
    element.controller.setOptions({ componentDefinitions: [] });
    expect(element.panel).toBe("components");

    // And a palette dismissed on an empty form stays dismissed.
    canvasEl(element).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(element.panel).toBeUndefined();
    element.controller.setOptions({ componentDefinitions: [] });
    expect(element.panel).toBeUndefined();
  });

  it("announces no panel change and paints no panel while it mounts", async () => {
    const heard: unknown[] = [];
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.addEventListener("builder-panel-change", (event) => heard.push((event as CustomEvent).detail));
    element.options = { initialRoot: formRoot([NAME]), componentTypes: [{ type: "text", label: "Text" }] };
    document.body.append(element);
    await until(() => element.shadowRoot?.querySelector("datum-builder-canvas")?.shadowRoot?.querySelector(".canvas-page"));
    expect(element.panel).toBeUndefined();
    expect(heard).toEqual([]);
  });

  it("puts a palette it opened away on a click on the canvas, and leaves one the author opened", async () => {
    const auto = await mount(formRoot([]));
    expect(auto.panel).toBe("components");
    canvasEl(auto).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(auto.panel).toBeUndefined();
    expect(shell(auto).querySelector(".wrap")!.hasAttribute("data-side-collapsed")).toBe(true);

    const chosen = await mount(formRoot([NAME], "chosen"));
    strip(chosen, "components").click();
    expect(chosen.panel).toBe("components");
    canvasEl(chosen).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(chosen.panel).toBe("components");
    // A form put in place does not take the author's choice back either.
    chosen.options = { initialRoot: formRoot([NAME, SEEDED_SUBMIT], "again") };
    expect(chosen.panel).toBe("components");
  });

  it("writes nothing to persist-panels for a palette it opened or shut, and remembers the author's choice", async () => {
    const auto = await mount(formRoot([]), (el) => el.setAttribute("persist-panels", "audit-a"));
    expect(auto.panel).toBe("components");
    canvasEl(auto).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(auto.panel).toBeUndefined();
    auto.options = { initialRoot: formRoot([], "empty-again") };
    expect(readPanelMemory("audit-a")).toBeUndefined();

    const chosen = await mount(formRoot([NAME], "chosen"), (el) => el.setAttribute("persist-panels", "audit-b"));
    expect(readPanelMemory("audit-b")).toBeUndefined();
    strip(chosen, "components").click();
    expect(readPanelMemory("audit-b")?.panel).toBe("components");
  });

  it("keeps the palette the shell's own when a dragged drawer is stored beside it, so an empty form still opens it next visit", async () => {
    const first = await mount(formRoot([]), (el) => el.setAttribute("persist-panels", "audit-a"));
    expect(first.panel).toBe("components");
    const grip = shell(first).querySelector<HTMLElement>('[data-resizer="side"]')!;
    grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, clientX: 100 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 160 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 160 }));
    // The width is stored, and no panel is named for the palette the shell opened.
    expect(readPanelMemory("audit-a")).toMatchObject({ panel: null, sideWidth: 300 });
    first.remove();

    const second = await mount(formRoot([], "later"), (el) => el.setAttribute("persist-panels", "audit-a"));
    expect(second.panel).toBe("components");
    expect(second.shadowRoot!.querySelector<HTMLElement>(".wrap")!.style.getPropertyValue("--db-side-w")).toBe("300px");
    // And on a form with components it still stays shut.
    second.remove();
    const third = await mount(formRoot([NAME], "filled"), (el) => el.setAttribute("persist-panels", "audit-a"));
    expect(third.panel).toBeUndefined();
  });

  it("lets a remembered layout win over the rule", async () => {
    const first = await mount(formRoot([NAME]), (el) => el.setAttribute("persist-panels", "audit-a"));
    strip(first, "components").click();
    first.remove();
    const second = await mount(formRoot([NAME], "later"), (el) => el.setAttribute("persist-panels", "audit-a"));
    expect(second.panel).toBe("components");
  });
});

describe("the answers tried in Try it", () => {
  async function typeName(element: DatumBuilderElement, value: string): Promise<void> {
    const renderer = (): HTMLElement => canvasRoot(element).querySelector<HTMLElement>("[data-preview]")!;
    await until(() => renderer().shadowRoot?.querySelector('[data-component-id="fullName"] input'));
    const input = renderer().shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => canvasEl(element).previewRuntime().state().values.fullName === value);
  }

  it("goes when Try it ends: the edit canvas and the next Try it start from nothing", async () => {
    const element = await mount(formRoot([NAME, SEEDED_SUBMIT]));
    canvasEl(element).previewing = true;
    await typeName(element, "Ada");
    expect(element.triedAnswers()).toEqual({ fullName: "Ada" });

    canvasEl(element).previewing = false;
    await until(() => canvasEl(element).previewRuntime().state().values.fullName === undefined);
    expect(element.triedAnswers()).toEqual({});

    canvasEl(element).previewing = true;
    await until(() => canvasRoot(element).querySelector<HTMLElement>("[data-preview]")!.shadowRoot?.querySelector('[data-component-id="fullName"] input'));
    const input = canvasRoot(element).querySelector<HTMLElement>("[data-preview]")!.shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    expect(input.value).toBe("");
    expect(element.triedAnswers()).toEqual({});
  });

  it("leaves the edit canvas with the form's defaults, not what was typed over them", async () => {
    const city: ComponentNode = { id: "city", type: "text", configuration: { label: "City" }, rules: { defaultValue: '"Ottawa"' } };
    const element = await mount(formRoot([NAME, city, SEEDED_SUBMIT]));
    const values = (): Record<string, unknown> => canvasEl(element).previewRuntime().state().values;
    expect(values().city).toBe("Ottawa");
    canvasEl(element).previewing = true;
    await typeName(element, "Ada");
    (canvasEl(element).previewRuntime() as unknown as { setValue(id: string, value: unknown): void }).setValue("city", "Paris");
    expect(values().city).toBe("Paris");

    canvasEl(element).previewing = false;
    await until(() => values().fullName === undefined);
    expect(values().city).toBe("Ottawa");
  });

  it("is cleared by a workspace switch that ends Try it, but not by one made while editing", async () => {
    const element = await mount(formRoot([NAME, SEEDED_SUBMIT]));
    canvasEl(element).previewing = true;
    await typeName(element, "Grace");
    // Leaving the workspace ends Try it: the answers go with it.
    element.workspace = "logic";
    await until(() => element.triedAnswers().fullName === undefined);
  });
});

describe("a form with no Submit button in Try it", () => {
  const panelOf = (element: DatumBuilderElement): HTMLElement => canvasRoot(element).querySelector<HTMLElement>("[data-try-panel]")!;
  const notice = (element: DatumBuilderElement): HTMLElement | null => panelOf(element).querySelector<HTMLElement>("[data-try-no-submit]");
  const buttons = (element: DatumBuilderElement): ComponentNode[] =>
    (element.controller.snapshot().children?.content ?? []).filter((node) => node.type === "button");

  async function trying(element: DatumBuilderElement): Promise<void> {
    canvasEl(element).previewing = true;
    await until(() => !panelOf(element).hidden && panelOf(element).querySelector("[data-try-check]"));
  }

  it("says so, and offers a Submit button at the end as one undo step", async () => {
    const element = await mount(formRoot([NAME]));
    await trying(element);
    expect(notice(element)?.textContent).toContain("This form has no Submit button, so it cannot be submitted.");
    expect(notice(element)!.getAttribute("role")).toBe("status");
    const before = element.controller.snapshot().children!.content!.length;

    panelOf(element).querySelector<HTMLElement>("[data-try-add-submit]")!.click();
    const content = element.controller.snapshot().children!.content!;
    expect(content).toHaveLength(before + 1);
    // The very button a new form starts with (one definition, `starterSubmitButton`), not a lookalike.
    expect(content.at(-1)).toEqual(SEEDED_SUBMIT);
    await until(() => notice(element) === null);

    // One Undo takes it back (the panel is drawn again with the next Try it).
    element.controller.undo();
    expect(buttons(element)).toHaveLength(0);
    expect(element.controller.snapshot().children!.content).toHaveLength(before);
    canvasEl(element).previewing = false;
    await trying(element);
    expect(notice(element)).not.toBeNull();
  });

  it("keeps the answers already typed when the button is added", async () => {
    const element = await mount(formRoot([NAME]));
    await trying(element);
    const renderer = (): HTMLElement => canvasRoot(element).querySelector<HTMLElement>("[data-preview]")!;
    await until(() => renderer().shadowRoot?.querySelector('[data-component-id="fullName"] input'));
    const input = renderer().shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    input.value = "Ada";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => element.triedAnswers().fullName === "Ada");
    panelOf(element).querySelector<HTMLElement>("[data-try-add-submit]")!.click();
    expect(element.triedAnswers()).toEqual({ fullName: "Ada" });
  });

  it("is quiet for a form with a submitting or downloading button", async () => {
    const submitting = await mount(formRoot([NAME, SEEDED_SUBMIT]));
    await trying(submitting);
    expect(notice(submitting)).toBeNull();

    const downloading = await mount(formRoot([NAME, { id: "save", type: "button", configuration: { label: "Save", action: "download" } }], "other"));
    await trying(downloading);
    expect(notice(downloading)).toBeNull();
  });

  it("is quiet for a form that opens as a journey, whose last page draws its own Submit, and says so again when it opens whole", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content = definition.root.children!.content!.filter((node) => node.type !== "button");
    definition.journey = { journeys: [{ id: "intake", name: "Intake", pages: [{ id: "all", components: ["fullName"] }] }], opensAs: "journey" };
    const wrapper = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    wrapper.definition = definition;
    document.body.append(wrapper);
    await until(() => wrapper.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(wrapper);
    const element = wrapper.builder as unknown as DatumBuilderElement;
    await trying(element);
    expect(notice(element)).toBeNull();

    // The same form kept whole: its one page has no Submit, so the notice is right.
    canvasEl(element).previewing = false;
    wrapper.definition = { ...definition, journey: { ...definition.journey, opensAs: "form" } };
    await modesReady(wrapper);
    await trying(element);
    await until(() => notice(element) !== null);
  });
});

describe("the document face", () => {
  it("gives the kind chip its whole word as a title and cuts a long chip with an ellipsis", async () => {
    const element = await mount(formRoot([NAME]));
    const chip = shell(element).querySelector<HTMLElement>("[data-document-kind]");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("title")).toBe(chip!.textContent);
    const css = [...shell(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    const rule = /\.document-face-type, \.document-face-badge \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
    expect(rule).toContain("overflow: hidden");
  });
});

describe("the File menu offers no publishing line", () => {
  it("holds file actions and the colour scheme alone, with or without a host's actions", async () => {
    const element = await mount(formRoot([NAME]), (el) => {
      el.fileActions = { new: () => undefined, download: () => ({ name: "form.json", text: "{}" }) };
    });
    const menu = shell(element).querySelector<HTMLElement>("[data-file-menu-list]")!;
    // Publishing is a host's own control in the bar's publish slot: the menu names no page for it.
    expect(menu.querySelector("[data-file-hint], [data-file-hint-sep], [data-file-publish]")).toBeNull();
    expect(menu.querySelector("a")).toBeNull();
    expect(menu.textContent).not.toMatch(/publish/i);
  });
});

describe("one name for the preview in the minimal builder", () => {
  const bottomTry = (element: DatumBuilderElement): string => shell(element).querySelector('[data-bottom-try] [data-t^="shell.bottom."]')!.textContent ?? "";
  const hiddenRow = (element: DatumBuilderElement): { label: string; note: string } => ({
    label: shell(element).querySelector('[data-show-hidden-field] [data-t^="view.showHidden.label"]')!.textContent ?? "",
    note: shell(element).querySelector("#show-hidden-note")!.textContent ?? ""
  });

  it("says Preview, and speaks of no rules, where Try it and Logic are left out", async () => {
    const full = await mount(formRoot([NAME]));
    expect(bottomTry(full)).toBe("Try it");
    expect(hiddenRow(full).label).toBe("Show components a rule hides");
    expect(hiddenRow(full).note).toContain("Try it shows the form");

    const minimal = await mount(formRoot([NAME], "other"), (el) => el.setAttribute("features", "minimal"));
    expect(bottomTry(minimal)).toBe("Preview");
    expect(hiddenRow(minimal).label).toBe("Show hidden components");
    expect(hiddenRow(minimal).note).not.toMatch(/rule|Try it/i);

    // Logic on, Try it off: the rule is spoken of, the preview is named Preview.
    const preview = await mount(formRoot([NAME], "third"), (el) => el.setAttribute("features", "logic"));
    expect(bottomTry(preview)).toBe("Preview");
    expect(hiddenRow(preview).note).toContain("Preview shows the form");
    expect(hiddenRow(preview).note).not.toContain("Try it");

    // The list changing back brings the words back.
    preview.setAttribute("features", "logic try-it");
    expect(bottomTry(preview)).toBe("Try it");
    expect(hiddenRow(preview).note).toContain("Try it shows the form");
  });
});

describe("palette Move to, the native unsaved cue, the Settings label and the Download warning", () => {
  const paletteRoot = (element: DatumBuilderElement): ShadowRoot | undefined => shell(element).querySelector("datum-builder-palette")?.shadowRoot ?? undefined;

  async function openPalette(element: DatumBuilderElement): Promise<void> {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
    await until(() => paletteRoot(element)?.querySelector("dialog")?.open);
  }

  function option(element: DatumBuilderElement, label: string): HTMLElement | undefined {
    return [...paletteRoot(element)!.querySelectorAll<HTMLElement>("[data-palette-option]")].find((entry) => entry.querySelector(".palette-label")?.textContent === label);
  }

  it("lists Move to... with the M shortcut, offered only with a selection, and runs the canvas's move action", async () => {
    const idle = await mount(formRoot([NAME, SEEDED_SUBMIT]));
    await openPalette(idle);
    const entry = option(idle, "Move to…");
    expect(entry).toBeDefined();
    expect(entry!.textContent).toContain("M");
    // Nothing selected: listed, not offered.
    expect(entry!.getAttribute("aria-disabled")).toBe("true");

    const element = await mount(formRoot([NAME, SEEDED_SUBMIT], "other"));
    const run = vi.spyOn(canvasEl(element) as unknown as { runAction(action: string): void }, "runAction").mockImplementation(() => undefined);
    element.controller.select("fullName");
    await openPalette(element);
    expect(option(element, "Move to…")!.getAttribute("aria-disabled")).toBeNull();
    option(element, "Move to…")!.click();
    expect(run).toHaveBeenCalledWith("move");
  });

  it("draws the unsaved cue itself from saveState, in the table's words, and leaves the history slot to the host", async () => {
    const element = await mount(formRoot([NAME]));
    const cue = (): HTMLElement => shell(element).querySelector<HTMLElement>("[data-save-cue]")!;
    expect(cue().hidden).toBe(true);
    element.saveState = "unsaved";
    expect(cue().hidden).toBe(false);
    expect(cue().textContent).toContain("Changes not saved");
    expect(cue().title).toBe("Changes not saved");
    expect(cue().querySelector("[aria-hidden=true]")).not.toBeNull();
    // The words are in view beside the dot, not kept for a screen reader and a tooltip alone.
    expect(cue().querySelector("[data-save-cue-text]")!.classList.contains("sr-only")).toBe(false);
    // Inside the bar, not in the host's slot: nothing is slotted for the page.
    expect(cue().closest("slot")).toBeNull();
    expect(element.querySelector("[slot=history]")).toBeNull();
    element.saveState = "saved";
    expect(cue().hidden).toBe(true);
    element.saveState = "unsaved";
    element.saveState = undefined;
    expect(cue().hidden).toBe(true);

    // The builder's language reaches it.
    element.textCatalog = { fr: { "shell.menu.unsaved": "Modifications non enregistrées" } };
    element.textLocale = "fr";
    element.saveState = "unsaved";
    expect(cue().textContent).toContain("Modifications non enregistrées");
    expect(cue().title).toBe("Modifications non enregistrées");
  });

  it("gives the Settings language select a visible label that names it, with no aria-label beside it", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const select = element.builder!.shadowRoot!.querySelector<HTMLElement & { locales: unknown[] }>("[data-settings-panel] [data-locale-select]")!;
    expect(select.hasAttribute("show-label")).toBe(true);
    await until(() => select.locales.length > 1);
    const inner = select.shadowRoot!;
    const label = inner.querySelector<HTMLElement>("label")!;
    expect(label.textContent).toBe("Show the form in");
    const pick = inner.querySelector("select")!;
    expect(pick.getAttribute("aria-labelledby")).toBe(label.id);
    expect(pick.hasAttribute("aria-label")).toBe(false);
  });

  it("words the Download warning in the builder's language, in the notice and in the event's warnings, English by default", async () => {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const definition = sampleDefinition();
    const noSubmit = { ...definition, root: { ...definition.root, children: { ...definition.root.children, content: (definition.root.children?.content ?? []).filter((child) => child.type !== "button") } } };
    const warningsOf = async (setup?: (element: DatumFormBuilderElement) => void): Promise<string[]> => {
      const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
      element.definition = noSubmit;
      setup?.(element);
      document.body.append(element);
      await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
      const heard: string[] = [];
      element.addEventListener("datum-builder-file-action", (event) => {
        heard.push(...((event as CustomEvent<{ warnings?: Array<{ message: string }> }>).detail.warnings ?? []).map((warning) => warning.message));
      });
      element.builder!.shadowRoot!.querySelector<HTMLButtonElement>("[data-file-download]")!.click();
      const notice = element.shadowRoot!.querySelector("[data-file-warning-message]")!.textContent;
      expect(notice).toBe(heard.join(" "));
      return heard;
    };
    const english = await warningsOf();
    expect(english).toHaveLength(1);
    expect(english[0]).toContain("This form has no Submit button, so nobody can send it.");

    const french = await warningsOf((element) => {
      element.textLocale = "fr";
      element.textCatalog = { fr: { "shell.file.noSubmitWarning": "Ce formulaire n'a pas de bouton Envoyer." } } as never;
    });
    expect(french).toEqual(["Ce formulaire n'a pas de bouton Envoyer."]);
  });

  it("counts the untouched seeded Submit as an empty form, so a New straight after a New asks nothing, and a touched one is work", async () => {
    const asked = async (content: ComponentNode[]): Promise<{ ran: number; confirm: boolean }> => {
      const element = await mount({ id: "root", type: "form", configuration: {}, children: { content } });
      const made = vi.fn();
      element.fileActions = { new: made, isEmpty: null } as unknown as typeof element.fileActions;
      shell(element).querySelector<HTMLButtonElement>("[data-file-new]")!.click();
      return { ran: made.mock.calls.length, confirm: shell(element).querySelector("[data-file-confirm]")!.hasAttribute("open") };
    };
    expect(await asked([SEEDED_SUBMIT])).toEqual({ ran: 1, confirm: false });
    expect(await asked([])).toEqual({ ran: 1, confirm: false });
    expect(await asked([{ ...SEEDED_SUBMIT, configuration: { label: "Send", action: "submit" } }])).toEqual({ ran: 0, confirm: true });
    expect(await asked([SEEDED_SUBMIT, NAME])).toEqual({ ran: 0, confirm: true });
    expect(await asked([{ ...SEEDED_SUBMIT, id: "go" }])).toEqual({ ran: 0, confirm: true });
  });
});
