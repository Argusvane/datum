import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import {
  BuilderController,
  DatumBuilderElement,
  type BuilderDocument,
  type BuilderDocumentChangeDetail,
  type BuilderMode,
  type BuilderModeChangeDetail,
  type BuilderModeContext,
  type ComponentNode
} from "@argusvane/datum-engine";

import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function notesRoot(id = "notes-root"): ComponentNode {
  return { id, type: "form", configuration: { title: "Notes" }, children: { content: [] } };
}

function mount(): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  document.body.append(element);
  return element;
}

function shadow(element: DatumBuilderElement): ShadowRoot {
  return element.shadowRoot!;
}

/** The bar's label for the document on the page. */
function face(element: DatumBuilderElement): HTMLElement {
  return shadow(element).querySelector<HTMLElement>("[data-document-face]")!;
}

/** The label, as read: its name, its kind, its badges, whether it is busy, and whether it opens the document's menu. */
function label(element: DatumBuilderElement): { name: string; kind: string | undefined; badges: string[]; busy: string | null; menu: boolean } {
  const el = face(element);
  return {
    name: el.querySelector("[data-document-picker-name]")!.textContent!,
    kind: el.querySelector("[data-document-kind]")?.textContent ?? undefined,
    badges: [...el.querySelectorAll(".document-face-badge")].map((badge) => badge.textContent!),
    busy: el.getAttribute("aria-busy"),
    menu: el.hasAttribute("data-document-menu")
  };
}

function documents(element: DatumBuilderElement): HTMLElement {
  return shadow(element).querySelector<HTMLElement>("[data-documents]")!;
}

function panelController(element: DatumBuilderElement, tag: string): BuilderController | undefined {
  return (shadow(element).querySelector(tag) as (HTMLElement & { controller: BuilderController | undefined }) | null)?.controller;
}

interface TestMode extends BuilderMode {
  activations: number;
  context: BuilderModeContext | undefined;
  disposed: boolean;
}

/** A second mode: another tree under another controller, with a bar action, an overlay and a stylesheet. */
function notesMode(
  options: { activate?: (context: BuilderModeContext) => void | Promise<void>; inspector?: BuilderMode["inspector"] } = {}
): TestMode {
  const controller = new BuilderController();
  controller.setOptions({ initialRoot: notesRoot(), componentTypes: [{ type: "text", label: "Note" }] });
  const action = document.createElement("button");
  action.setAttribute("data-notes-action", "");
  action.textContent = "Notes…";
  const dialog = document.createElement("dialog");
  dialog.setAttribute("data-notes-dialog", "");
  const mode: TestMode = {
    id: "notes",
    label: "Notes",
    controller,
    barActions: [action],
    overlays: [dialog],
    styles: ".notes-only { color: red; }",
    ...(options.inspector ? { inspector: options.inspector } : {}),
    activations: 0,
    context: undefined,
    disposed: false,
    activate: async (context) => {
      mode.activations += 1;
      mode.context = context;
      await options.activate?.(context);
    },
    dispose: () => {
      mode.disposed = true;
    }
  };
  return mode;
}

interface DocumentsMode extends BuilderMode {
  controllers: Map<string, BuilderController>;
  selected: string;
  list: BuilderDocument[];
  notify(): void;
  added: number;
  /** The anchor each `add` was handed. */
  anchors: Array<HTMLElement | undefined>;
  /** Whether each anchor was on the page when `add` was handed it: a popover places itself under it then. */
  anchorsOnPage: boolean[];
  /** The kind each `add` was asked for. */
  kinds: Array<string | undefined>;
}

/**
 * A mode with several documents (the PDF designer's layouts): one controller per document,
 * a list whose selected one the bar's label names, and every catalog action offered. `id`, `label` and `noun`
 * make a second such mode (journeys); `removeToZero` lets its last document go.
 */
function documentsMode(
  ids: string[] = ["letter", "a4"],
  options: { id?: string; label?: string; noun?: string; removeToZero?: boolean } = {}
): DocumentsMode {
  const listeners = new Set<() => void>();
  const controllers = new Map<string, BuilderController>();
  const controllerFor = (id: string): BuilderController => {
    let controller = controllers.get(id);
    if (!controller) {
      controller = new BuilderController();
      controller.setOptions({ initialRoot: notesRoot(`${id}-root`), componentTypes: [{ type: "text", label: "Note" }] });
      controllers.set(id, controller);
    }
    return controller;
  };
  const idle = new BuilderController();
  const mode: DocumentsMode = {
    id: options.id ?? "pdf",
    label: options.label ?? "PDF",
    controllers,
    selected: ids[0] ?? "",
    list: ids.map((id, index) => ({ id, label: id.toUpperCase(), isDefault: index === 0 })),
    added: 0,
    anchors: [],
    anchorsOnPage: [],
    kinds: [],
    get controller() {
      return mode.list.length > 0 ? controllerFor(mode.selected) : idle;
    },
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    documents: {
      ...(options.noun !== undefined ? { noun: options.noun } : {}),
      list: () => mode.list,
      selectedId: () => (mode.list.length > 0 ? mode.selected : undefined),
      select: (id) => {
        mode.selected = id;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      add: (anchor, kind) => {
        mode.anchors.push(anchor);
        mode.anchorsOnPage.push(anchor?.isConnected === true);
        mode.kinds.push(kind);
        mode.added += 1;
        const id = `${options.noun ?? "layout"}-${mode.added}`;
        mode.list = [...mode.list, { id, label: `${options.noun === undefined ? "Layout" : options.noun} ${mode.added}` }];
        mode.selected = id;
        mode.notify();
      },
      rename: (id, name) => {
        mode.list = mode.list.map((document) => (document.id === id ? { ...document, label: name } : document));
        mode.notify();
      },
      duplicate: (id) => {
        const source = mode.list.find((document) => document.id === id)!;
        const copy = { ...source, id: `${id}-copy`, label: `${source.label} (copy)`, isDefault: false };
        mode.list = [...mode.list, copy];
        mode.selected = copy.id;
        mode.notify();
      },
      remove: (id) => {
        if (mode.list.length === 1 && !options.removeToZero) {
          return;
        }
        mode.list = mode.list.filter((document) => document.id !== id);
        controllers.delete(id);
        if (mode.selected === id) {
          mode.selected = mode.list[0]?.id ?? "";
        }
        mode.notify();
      },
      setDefault: (id) => {
        mode.list = mode.list.map((document) => ({ ...document, isDefault: document.id === id }));
        mode.notify();
      }
    }
  };
  return mode;
}

describe("<datum-builder> modes", () => {
  it("labels the form on the page with the form alone and once another mode is added, and guards the ids", async () => {
    const element = mount();
    await until(() => documents(element));
    // The label names the document on the page, so it is up with the form alone too: the
    // form's own title, not the word "Form", which is its kind.
    expect(documents(element).hidden).toBe(false);
    expect(label(element)).toEqual({ name: "Sample", kind: "Form", badges: [], busy: null, menu: false });
    expect(element.modes).toEqual([{ id: "form", label: "Form" }]);
    expect(element.mode).toBe("form");
    // No dropdown and no + beside it: other documents are reached from the Journeys and PDF overviews.
    expect(shadow(element).querySelector("[data-document-picker]")).toBeNull();
    expect(shadow(element).querySelector("[data-document-list]")).toBeNull();
    expect(shadow(element).querySelector("[data-document-add]")).toBeNull();

    const notes = notesMode();
    element.addMode(notes);
    expect(documents(element).hidden).toBe(false);
    expect(label(element).name).toBe("Sample");
    expect(() => element.addMode(notesMode())).toThrow(/already exists/);
    expect(() => element.addMode({ id: "form", label: "Form", controller: new BuilderController() })).toThrow(/builder's own mode/);
    expect(() => element.setMode("nope")).toThrow(/No builder mode/);
    expect(() => element.removeMode("form")).toThrow(/builder's own mode/);

    element.showModeSwitch = false;
    expect(documents(element).hidden).toBe(true);
    element.showModeSwitch = true;
    expect(documents(element).hidden).toBe(false);

    // A mode a host keeps off the bar (the standalone PDF designer hides the form) is still
    // there, but the label does not name it.
    element.hiddenModeIds = ["form"];
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "notes"]);
    expect(documents(element).hidden).toBe(true);
    element.hiddenModeIds = [];
    expect(documents(element).hidden).toBe(false);
    expect(label(element).name).toBe("Sample");
  });

  it("puts a mode added with before ahead of that mode; a name not registered, or the form's, appends", async () => {
    const element = mount();
    await until(() => documents(element));
    const plain = (id: string): BuilderMode => ({ id, label: id, controller: new BuilderController() });
    element.addMode(notesMode());
    // A side a host takes away and brings back keeps its place without the others going too.
    element.addMode(plain("pages"), { before: "notes" });
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pages", "notes"]);
    element.addMode(plain("sketch"), { before: "missing" });
    element.addMode(plain("extra"), { before: "form" });
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pages", "notes", "sketch", "extra"]);
  });

  it("keeps the bar up with the form alone: its own controls live there, whatever the host slots", async () => {
    const element = mount();
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const bar = shadow(element).querySelector<HTMLElement>('[data-shell="bar"]')!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector("[data-undo]")).toBeTruthy();
    // The locale switcher moved to the Settings panel, and the canvas controls
    // (width, design system, show hidden) to the strip's View panel, so the bar carries
    // undo/redo, the tabs and the host's slots.
    expect(bar.querySelector("[data-locale-select]")).toBeNull();
    expect(shadow(element).querySelector("[data-settings-panel] [data-locale-select]")).toBeTruthy();
    expect(bar.querySelector("[data-preview-width]")).toBeNull();
    expect(shadow(element).querySelector("[data-view-panel] [data-preview-width]")).toBeTruthy();
    // The divider between the host's leading controls and undo/redo shows only once something is slotted.
    const sep = bar.querySelector<HTMLElement>("[data-host-sep]")!;
    expect(sep.hidden).toBe(true);
    const save = document.createElement("button");
    save.slot = "toolbar-start";
    save.textContent = "Save";
    element.append(save);
    await until(() => !sep.hidden);
    save.remove();
    await until(() => sep.hidden);
  });

  it("switches modes, re-points the panels, keeps each mode's own tree and history, and mounts the mode's chrome in its shadow", async () => {
    const element = mount();
    await until(() => documents(element));
    element.controller.add("text");
    expect(element.value.children?.content?.length).toBe(2);

    const notes = notesMode();
    element.addMode(notes);
    const changes: BuilderModeChangeDetail[] = [];
    document.addEventListener("builder-mode-change", (event) => changes.push((event as CustomEvent<BuilderModeChangeDetail>).detail));

    expect(element.setMode("notes")).toBe(true);
    await until(() => element.mode === "notes");
    expect(notes.activations).toBe(1);
    expect(element.getAttribute("mode")).toBe("notes");
    expect(changes.at(-1)).toEqual({ mode: "notes", previous: "form" });
    // A mode with no documents is named by its label, with no kind to give.
    expect(label(element)).toEqual({ name: "Notes", kind: undefined, badges: [], busy: null, menu: false });
    // The panels are on the mode's controller; the shell's own API stays the form's.
    expect(element.activeController).toBe(notes.controller);
    expect(panelController(element, "datum-builder-canvas")).toBe(notes.controller);
    expect(panelController(element, "datum-builder-toolbar")).toBe(notes.controller);
    expect(panelController(element, "datum-builder-outline")).toBe(notes.controller);
    expect(panelController(element, "datum-builder-properties")).toBe(notes.controller);
    expect(element.controller).not.toBe(notes.controller);
    expect(element.value.id).toBe("root");
    expect(shadow(element).querySelector<HTMLElement>(".wrap")!.dataset.mode).toBe("notes");
    // The mode's chrome lives in the shell's shadow: its worded action in the canvas's toolbar, the overlay and style at the root.
    expect(shadow(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-canvas-bar] [data-canvas-actions] [data-notes-action]")).toBeTruthy();
    expect(shadow(element).querySelector("[data-notes-dialog]")).toBeTruthy();
    expect(shadow(element).querySelector('style[data-mode-style="notes"]')?.textContent).toContain("notes-only");
    expect(element.querySelector("[data-notes-action]")).toBeNull();

    // Edits and undo act on the mode on the page, from the API and from the bar alike.
    element.activeController.add("text", "notes-root", "content");
    expect(notes.controller.snapshot().children?.content?.length).toBe(1);
    const undo = shadow(element).querySelector<HTMLButtonElement>("[data-undo]")!;
    expect(undo.disabled).toBe(false);
    undo.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(notes.controller.snapshot().children?.content?.length).toBe(0);
    element.redo();
    expect(notes.controller.snapshot().children?.content?.length).toBe(1);
    expect(element.value.children?.content?.length).toBe(2);

    // Back to the form: the mode's chrome comes down; its tree and history wait for the next visit.
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(shadow(element).querySelector("[data-notes-action]")).toBeNull();
    expect(shadow(element).querySelector("[data-notes-dialog]")).toBeNull();
    expect(shadow(element).querySelector('style[data-mode-style="notes"]')).toBeNull();
    expect(panelController(element, "datum-builder-canvas")).toBe(element.controller);
    expect(shadow(element).querySelector<HTMLElement>(".wrap")!.dataset.mode).toBeUndefined();
    element.mode = "notes";
    await until(() => element.mode === "notes");
    expect(notes.activations).toBe(2);
    expect(notes.controller.snapshot().children?.content?.length).toBe(1);
    expect(notes.controller.canUndo()).toBe(true);
  });

  it("keeps the form-level language switcher to the form, even when another mode declares the form's locales", async () => {
    const localization = { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français (Canada)" }] };
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }], localization };
    document.body.append(element);
    await until(() => documents(element));
    // Form-level editing is the strip's Form panel, not the inspector's empty state.
    const formPanelRoot = (): ShadowRoot => {
      const panel = shadow(element).querySelector("datum-builder-form-panel") as HTMLElement;
  // A panel behind its strip item is not on screen and does not paint, so it is opened the
  // way an author opens it. Harmless when it is already open.
      if (panel.hidden) {
        shadow(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
      }
      return panel.shadowRoot!;
    };
    const switcher = (): { locales: unknown[] } => shadow(element).querySelector("[data-locale-select]") as unknown as { locales: unknown[] };

    // The form root: the switcher over the form's locales. The Form panel has no Localization
    // section any more: the languages are the Languages workspace's.
    expect(formPanelRoot().querySelector('[data-inspector-section="localization"]')).toBeNull();
    expect(switcher().locales.length).toBe(2);

    // Another mode whose controller declares the same locales — a PDF layout's document, say,
    // whose own text is authored per locale — gets no switcher: the list is the definition's,
    // edited on the Form side only.
    const notes = notesMode();
    notes.controller.setLocalization(localization);
    element.addMode(notes);
    element.setMode("notes");
    await until(() => element.mode === "notes");
    expect(panelController(element, "datum-builder-form-panel")).toBe(notes.controller);
    expect(switcher().locales).toEqual([]);

    // Back on the form, the switcher returns.
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(switcher().locales.length).toBe(2);
  });

  it("offers the Rules tab only for a mode that keeps it, falling back to Properties when it goes", async () => {
    const element = mount();
    await until(() => documents(element));
    const propertiesRoot = (): ShadowRoot => shadow(element).querySelector("datum-builder-properties")!.shadowRoot!;
    const tabIds = (): string[] => [...propertiesRoot().querySelectorAll<HTMLElement>("[data-inspector-tab]")].map((tab) => tab.dataset.inspectorTab!);
    const activeTab = (): string | undefined => propertiesRoot().querySelector<HTMLElement>(".inspector-tab.active")?.dataset.inspectorTab;

    element.controller.select("fullName");
    propertiesRoot().querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
    expect(activeTab()).toBe("rules");
    expect(propertiesRoot().querySelector('[data-rule-section="visibleWhen"]')).toBeTruthy();

    // A mode whose tree carries no rules anything reads — a PDF layout's — leaves the tab out.
    // The inspector draws only over a selection, so each mode's gets one.
    const selectFirst = (): void => {
      const controller = element.activeController;
      controller.add("text");
    };
    element.addMode(notesMode({ inspector: { rules: false } }));
    element.setMode("notes");
    await until(() => element.mode === "notes");
    selectFirst();
    expect(tabIds()).toEqual(["properties", "json"]);
    expect(activeTab()).toBe("properties");
    expect(propertiesRoot().querySelector("[data-rule-section]")).toBeNull();

    // Back on the form the tab is offered again; the panel stays on Properties.
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(tabIds()).toEqual(["properties", "rules", "json"]);
    expect(activeTab()).toBe("properties");

    // A mode that says nothing keeps every tab.
    element.removeMode("notes");
    element.addMode(notesMode());
    element.setMode("notes");
    await until(() => element.mode === "notes");
    selectFirst();
    expect(tabIds()).toEqual(["properties", "rules", "json"]);
  });

  it("carries the form's title on the bar's label, following an edit to it", async () => {
    const element = mount();
    await until(() => documents(element));
    element.addMode(documentsMode());
    const formLabel = (): string => label(element).name;
    expect(formLabel()).toBe("Sample");
    expect(face(element).title).toBe("Sample");

    // Drafted, not saved: the label follows what is being typed, as the canvas does.
    element.controller.setDraftProperty("root", "title", "Customer intake");
    await until(() => formLabel() === "Customer intake");
    expect(face(element).title).toBe("Customer intake");
    element.controller.discardDraft("root");
    await until(() => formLabel() === "Sample");

    // A form with no title falls back to the mode's own label rather than an empty one.
    element.controller.setDraftProperty("root", "title", "   ");
    await until(() => formLabel() === "Form");
    expect(label(element).kind).toBe("Form");
  });

  it("names the document on the page on the bar's label, with its kind, and walks the document's menu from the keyboard", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode();
    element.addMode(pdf);
    const menu = (): HTMLElement => shadow(element).querySelector<HTMLElement>("[data-document-menu-popover]")!;
    const deepActive = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const press = (key: string): void => {
      deepActive()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
    };

    // The form, by its title and its kind; with nothing to act on, a plain label, not a button.
    expect(label(element)).toEqual({ name: "Sample", kind: "Form", badges: [], busy: null, menu: false });
    expect(face(element).tagName).toBe("SPAN");
    expect(face(element).title).toBe("Sample");

    // A switch moves the label to the document on the page.
    expect(element.selectDocument("pdf", "a4")).toBe(true);
    await until(() => element.mode === "pdf" && pdf.selected === "a4");
    expect(label(element)).toEqual({ name: "A4", kind: "Document", badges: [], busy: null, menu: true });
    // With options, the label is the button that opens them: closed by default, its tooltip saying what it opens.
    const button = face(element);
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.title).toBe("Document options");
    expect(menu().hidden).toBe(true);

    // Open: focus on the first item. The arrows walk the items, wrapping; Home and End jump to the ends.
    button.click();
    expect(menu().hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect((deepActive() as HTMLElement).dataset.documentAction).toBe("rename");
    press("ArrowDown");
    expect((deepActive() as HTMLElement).dataset.documentAction).toBe("duplicate");
    press("ArrowUp");
    press("ArrowUp");
    expect((deepActive() as HTMLElement).dataset.documentAction).toBe("remove");
    press("Home");
    expect((deepActive() as HTMLElement).dataset.documentAction).toBe("rename");
    press("End");
    expect((deepActive() as HTMLElement).dataset.documentAction).toBe("remove");
    // Escape puts it away, focus back on the label.
    press("Escape");
    expect(menu().hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(deepActive()).toBe(face(element));

    // A click elsewhere in the shell closes an open menu.
    face(element).click();
    expect(menu().hidden).toBe(false);
    shadow(element).querySelector<HTMLElement>("[data-strip]")!.click();
    expect(menu().hidden).toBe(true);

    // Back on the form the label is the form's, following a drafted rename of its title.
    element.setMode("form");
    await until(() => element.mode === "form");
    expect(label(element)).toEqual({ name: "Sample", kind: "Form", badges: [], busy: null, menu: false });
    element.controller.setDraftProperty("root", "title", "Customer intake");
    await until(() => label(element).name === "Customer intake");
  });

  it("holds a switch behind the unsaved-edits prompt of the mode being left", async () => {
    const element = mount();
    await until(() => documents(element));
    element.addMode(notesMode());
    element.controller.select("fullName");
    element.controller.setDraftProperty("fullName", "label", "Full name, edited");
    expect(element.setMode("notes")).toBe(false);
    expect(element.mode).toBe("form");
    expect(element.controller.unsavedChangesPrompt()).toBeTruthy();
    // Set through the attribute, the attribute says what is really on the page while the prompt is up.
    element.setAttribute("mode", "notes");
    expect(element.getAttribute("mode")).toBe("form");
    element.controller.answerUnsavedChangesPrompt("discard");
    await until(() => element.mode === "notes");
    expect(element.getAttribute("mode")).toBe("notes");

    // Set through the property, it is the same switch: held the same way.
    element.activeController.add("text", "notes-root", "content");
    element.activeController.select(element.activeController.snapshot().children!.content![0]!.id);
    element.activeController.setDraftProperty(element.activeController.snapshot().children!.content![0]!.id, "label", "Edited");
    element.mode = "form";
    expect(element.mode).toBe("notes");
    expect(label(element).name).toBe("Notes");
    expect(element.activeController.unsavedChangesPrompt()).toBeTruthy();
    element.activeController.answerUnsavedChangesPrompt("discard");
    await until(() => element.mode === "form");
  });

  it("shows a mode's surface on the canvas in the sheet's place, with the panels and the bar staying put", async () => {
    const element = mount();
    await until(() => documents(element));
    const card = document.createElement("div");
    card.setAttribute("data-notes-card", "");
    const notes = notesMode({
      activate: (context) => {
        // Asked for before the mode is on the page: honoured when it is.
        context.showCanvasSurface(card);
      }
    });
    element.addMode(notes);
    element.setMode("notes");
    await until(() => element.mode === "notes");
    const canvas = shadow(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    const host = canvas.querySelector<HTMLElement>("[data-canvas-surface]")!;
    const page = canvas.querySelector<HTMLElement>(".canvas-page")!;
    expect(host.hidden).toBe(false);
    expect(host.querySelector("[data-notes-card]")).toBe(card);
    expect(page.hasAttribute("data-surface")).toBe(true);
    // The mode's stylesheet travels with the surface into the canvas's shadow root, where the
    // shell's own copy does not reach.
    expect(host.querySelector("style[data-surface-styles]")?.textContent).toContain(".notes-only");
    // The panels beside the canvas and the mode's action in the canvas's toolbar are where they were.
    expect(shadow(element).querySelector("datum-builder-toolbar")).toBeTruthy();
    expect(shadow(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-canvas-actions] [data-notes-action]")).toBeTruthy();

    // The sheet again.
    notes.context!.showCanvasSurface(undefined);
    expect(host.hidden).toBe(true);
    expect(page.hasAttribute("data-surface")).toBe(false);
    expect(host.querySelector("[data-notes-card]")).toBeNull();
    expect(host.querySelector("style[data-surface-styles]")).toBeNull();

    // Leaving the mode while its surface is up brings the sheet back for the form.
    notes.context!.showCanvasSurface(card);
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(host.hidden).toBe(true);
    expect(page.hasAttribute("data-surface")).toBe(false);
  });

  it("shows the label busy while a mode activates, and stays put when activation fails", async () => {
    const element = mount();
    await until(() => documents(element));
    let release: () => void = () => undefined;
    const slow = notesMode({ activate: () => new Promise<void>((resolve) => (release = resolve)) });
    element.addMode(slow);
    element.setMode("notes");
    // The label still names the document being left while the next one comes up.
    await until(() => label(element).busy === "true");
    expect(label(element).name).toBe("Sample");
    expect(element.mode).toBe("form");
    release();
    await until(() => element.mode === "notes");
    expect(label(element)).toMatchObject({ name: "Notes", busy: null });

    const errors: Array<{ mode: string; error: unknown }> = [];
    document.addEventListener("builder-mode-error", (event) => errors.push((event as CustomEvent<{ mode: string; error: unknown }>).detail));
    const failing: BuilderMode = {
      id: "broken",
      label: "Broken",
      controller: new BuilderController(),
      activate: () => {
        throw new Error("no such thing");
      }
    };
    element.addMode(failing);
    element.setMode("broken");
    await until(() => errors.length > 0);
    expect(errors[0]).toMatchObject({ mode: "broken" });
    expect(element.mode).toBe("notes");
    expect(label(element)).toMatchObject({ name: "Notes", busy: null });
  });

  it("removes a mode, returning to the form when it was on the page, and honours a mode attribute once the mode exists", async () => {
    const element = mount();
    await until(() => documents(element));
    element.setAttribute("mode", "notes");
    expect(element.mode).toBe("form");
    const notes = notesMode();
    element.addMode(notes);
    await until(() => element.mode === "notes");

    element.removeMode("notes");
    expect(element.mode).toBe("form");
    expect(element.getAttribute("mode")).toBe("form");
    expect(notes.disposed).toBe(true);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(documents(element).hidden).toBe(false);
    expect(label(element).name).toBe("Sample");
    expect(shadow(element).querySelector("[data-notes-action]")).toBeNull();
    element.removeMode("notes"); // gone already: nothing happens
  });

  it("moves between a mode's documents through the guard, naming each on the label, and re-points the panels at each one's controller", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode();
    element.addMode(pdf);
    // The form's label carries the form's own title, not the word "Form".
    expect(label(element).name).toBe("Sample");
    const documentChanges: BuilderDocumentChangeDetail[] = [];
    document.addEventListener("builder-document-change", (event) => documentChanges.push((event as CustomEvent<BuilderDocumentChangeDetail>).detail));

    // Selecting another mode's document activates the mode on that document.
    expect(element.selectDocument("pdf", "a4")).toBe(true);
    await until(() => element.mode === "pdf" && pdf.selected === "a4");
    expect(label(element).name).toBe("A4");
    expect(element.activeController).toBe(pdf.controllers.get("a4"));
    expect(panelController(element, "datum-builder-canvas")).toBe(pdf.controllers.get("a4"));
    expect(documentChanges.at(-1)).toEqual({ mode: "pdf", document: "a4" });

    // Each document keeps its own tree and history across a visit to another.
    element.activeController.add("text", "a4-root", "content");
    expect(element.selectDocument("pdf", "letter")).toBe(true);
    await until(() => pdf.selected === "letter");
    expect(label(element).name).toBe("LETTER");
    expect(element.activeController).toBe(pdf.controllers.get("letter"));
    expect(panelController(element, "datum-builder-properties")).toBe(pdf.controllers.get("letter"));
    expect(element.activeController.snapshot().children?.content?.length).toBe(0);
    element.selectDocument("pdf", "a4");
    await until(() => pdf.selected === "a4");
    expect(element.activeController.snapshot().children?.content?.length).toBe(1);
    expect(element.activeController.canUndo()).toBe(true);

    // Moving between documents goes through the unsaved-edits guard, like moving between modes.
    const noteId = element.activeController.snapshot().children!.content![0]!.id;
    element.activeController.select(noteId);
    element.activeController.setDraftProperty(noteId, "label", "Edited");
    expect(element.selectDocument("pdf", "letter")).toBe(false);
    expect(pdf.selected).toBe("a4");
    expect(label(element).name).toBe("A4");
    element.activeController.answerUnsavedChangesPrompt("discard");
    await until(() => pdf.selected === "letter");
    expect(documentChanges.at(-1)).toEqual({ mode: "pdf", document: "letter" });

    // The form's mode brings the form back.
    element.setMode("form");
    await until(() => element.mode === "form");
    expect(label(element).name).toBe("Sample");
    expect(panelController(element, "datum-builder-canvas")).toBe(element.controller);
    expect(documentChanges.at(-1)).toEqual({ mode: "form", document: undefined });
  });

  it("adds a document through newDocument, and renames, duplicates, defaults and deletes it from the label's menu", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode();
    element.addMode(pdf);
    // The label is redrawn as the page moves, so it is read afresh each time.
    const menuButton = (): HTMLElement | null => shadow(element).querySelector<HTMLElement>("[data-document-menu]");
    // On the form there is no document to act on: the label opens no menu.
    expect(menuButton()).toBeNull();

    // Asked from the form, the page moves to the mode first (its add flow is part of its
    // chrome, up only while it is active), then the mode adds.
    expect(element.newDocument("pdf")).toBe(true);
    await until(() => pdf.added === 1);
    expect(element.mode).toBe("pdf");
    expect(pdf.list.map((document) => document.id)).toEqual(["letter", "a4", "layout-1"]);
    // The mode selected what it added: the shell followed it onto the new document's controller.
    expect(element.activeController).toBe(pdf.controllers.get("layout-1"));
    expect(label(element).name).toBe("Layout 1");
    expect(menuButton()).toBeTruthy();

    const menu = shadow(element).querySelector<HTMLElement>("[data-document-menu-popover]")!;
    const item = (action: string): HTMLButtonElement => menu.querySelector<HTMLButtonElement>(`[data-document-action="${action}"]`)!;
    menuButton()!.click();
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll<HTMLElement>("[data-document-action]")].map((button) => button.dataset.documentAction)).toEqual([
      "rename",
      "duplicate",
      "default",
      "remove"
    ]);

    // Rename in place: the label gives way to a box; Enter commits, Escape keeps the name.
    item("rename").click();
    const box = shadow(element).querySelector<HTMLInputElement>("[data-document-rename]")!;
    expect(box.value).toBe("Layout 1");
    expect(shadow(element).querySelector("[data-document-face]")).toBeNull();
    box.value = "Client copy";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(pdf.list.find((document) => document.id === "layout-1")?.label).toBe("Client copy");
    expect(label(element).name).toBe("Client copy");
    menuButton()!.click();
    item("rename").click();
    const box2 = shadow(element).querySelector<HTMLInputElement>("[data-document-rename]")!;
    box2.value = "Discarded";
    box2.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(label(element).name).toBe("Client copy");

    // Default: the item is off on the document that already is, and the label says it is.
    menuButton()!.click();
    expect(item("default").disabled).toBe(false);
    item("default").click();
    expect(pdf.list.find((document) => document.id === "layout-1")?.isDefault).toBe(true);
    expect(label(element).badges).toEqual(["Default"]);
    menuButton()!.click();
    expect(item("default").disabled).toBe(true);
    item("duplicate").click();
    await until(() => pdf.selected === "layout-1-copy");
    expect(element.activeController).toBe(pdf.controllers.get("layout-1-copy"));
    expect(label(element)).toMatchObject({ name: "Client copy (copy)", badges: [] });

    // Undo brings a deleted document back, so Delete asks in place: the menu becomes the warning note, Cancel first.
    menuButton()!.click();
    item("remove").click();
    expect(menu.hidden).toBe(false);
    const note = menu.querySelector<HTMLElement>(".note.confirm[data-tone='warning'][data-remove-note]")!;
    expect(note.textContent).toContain("Client copy (copy)");
    expect(menu.hasAttribute("role")).toBe(false);
    expect(shadow(element).activeElement).toBe(note.querySelector("[data-document-remove-keep]"));
    menu.querySelector<HTMLElement>("[data-document-action='remove'][data-confirm]")!.click();
    await until(() => !pdf.list.some((document) => document.id === "layout-1-copy"));
    expect(menu.hidden).toBe(true);
    expect(pdf.selected).toBe("letter");
    expect(element.activeController).toBe(pdf.controllers.get("letter"));
    expect(label(element).name).toBe("LETTER");

    // Removing the mode takes its documents and its subscription with it: the form is back on
    // the label, and the mode can no longer add.
    element.removeMode("pdf");
    expect(label(element).name).toBe("Sample");
    expect(element.newDocument("pdf")).toBe(false);
  });

  it("puts the canvas controls and the show-hidden switch on a View panel, and takes a host's own item on the strip", async () => {
    const element = mount();
    await until(() => documents(element));
    const strip = (panel: string): HTMLElement => shadow(element).querySelector<HTMLElement>(`[data-strip] [data-panel="${panel}"]`)!;
    const view = shadow(element).querySelector<HTMLElement>("[data-view-panel]")!;
    expect(view.hidden).toBe(true);

    strip("view").click();
    expect(element.panel).toBe("view");
    expect(view.hidden).toBe(false);
    // Width and the design system, each with a label rather than a tooltip.
    expect(view.querySelector("[data-preview-width]")).toBeTruthy();
    expect(view.querySelector("[data-binding-field] select[data-binding]")).toBeTruthy();
    // Show-hidden is a labelled switch on View, on unless turned off; none on the strip.
    expect(shadow(element).querySelector("[data-strip-card] [data-show-hidden]")).toBeNull();
    const toggle = view.querySelector<HTMLInputElement>("input[type=checkbox][data-show-hidden]")!;
    expect(toggle.closest("label")!.textContent!.trim()).toBe("Show components a rule hides");
    expect(toggle.getAttribute("aria-describedby")).toBe("show-hidden-note");

    // They still drive the controller from here, as they did from the bar.
    const width = view.querySelector<HTMLSelectElement>("[data-preview-width]")!;
    width.value = "768";
    width.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(element.controller.previewWidth()).toBe(768);
    expect(element.controller.showHiddenComponents()).toBe(true);
    expect(toggle.checked).toBe(true);
    toggle.click();
    expect(element.controller.showHiddenComponents()).toBe(false);
    expect(toggle.checked).toBe(false);
    element.controller.setShowHiddenComponents(true);
    await until(() => toggle.checked);

    // A host's own launcher rides the strip through its slot, below the built-in items.
    const sources = document.createElement("button");
    sources.slot = "strip";
    sources.textContent = "Data sources";
    element.append(sources);
    await until(() => shadow(element).querySelector<HTMLSlotElement>('[data-strip] slot[name="strip"]')!.assignedElements().length === 1);
    expect(shadow(element).querySelector<HTMLSlotElement>('slot[name="strip"]')!.assignedElements()[0]).toBe(sources);
  });

  it("opens one panel at a time from the activity strip: the palette, the outline, or neither", async () => {
    const element = mount();
    await until(() => documents(element));
    const strip = (panel: string): HTMLElement => shadow(element).querySelector<HTMLElement>(`[data-strip] [data-panel="${panel}"]`)!;
    const toolbar = shadow(element).querySelector<HTMLElement>("datum-builder-toolbar")!;
    const outline = shadow(element).querySelector<HTMLElement>("datum-builder-outline")!;
    const wrap = shadow(element).querySelector<HTMLElement>(".wrap")!;
    // The form has a component, so the palette starts shut; the strip item opens it.
    expect(element.panel).toBeUndefined();
    expect(toolbar.hidden).toBe(true);
    expect(strip("components").getAttribute("aria-selected")).toBe("false");
    strip("components").click();
    expect(element.panel).toBe("components");
    expect(toolbar.hidden).toBe(false);
    expect(outline.hidden).toBe(true);
    expect(strip("components").getAttribute("aria-selected")).toBe("true");

    strip("outline").click();
    expect(element.panel).toBe("outline");
    expect(toolbar.hidden).toBe(true);
    expect(outline.hidden).toBe(false);
    // The outline is the form's index: every component, the selection marked, a click selecting.
    const rows = () => [...outline.shadowRoot!.querySelectorAll<HTMLElement>("[data-tree-select]")].map((row) => row.dataset.treeSelect);
    expect(rows()).toEqual(["root", "fullName"]);
    outline.shadowRoot!.querySelector<HTMLElement>('[data-tree-select="fullName"]')!.click();
    expect(element.controller.selectedComponentId()).toBe("fullName");
    expect(outline.shadowRoot!.querySelector(".tree-select.active")?.getAttribute("data-tree-select")).toBe("fullName");
    element.controller.add("text");
    expect(rows().length).toBe(3);

    // The open panel's item closes the side column. The strip has no Translations item any more
    //: translations are the Languages workspace's.
    strip("outline").click();
    expect(element.panel).toBeUndefined();
    expect(wrap.hasAttribute("data-side-collapsed")).toBe(true);
    expect(shadow(element).querySelector('[data-strip] [data-panel="translations"]')).toBeNull();
    element.panel = "components";
    expect(wrap.hasAttribute("data-side-collapsed")).toBe(false);
    expect(toolbar.hidden).toBe(false);
  });
});

describe("<datum-builder> mode seams", () => {
  const menuPopover = (element: DatumBuilderElement): HTMLElement => shadow(element).querySelector<HTMLElement>("[data-document-menu-popover]")!;
  const menuButton = (element: DatumBuilderElement): HTMLButtonElement => shadow(element).querySelector<HTMLButtonElement>("[data-document-menu]")!;

  it("words the label for the document on the page in its mode's noun, or its own, and keeps the PDF's words", async () => {
    const element = mount();
    await until(() => documents(element));
    const journeys = documentsMode(["short", "long"], { id: "journeys", label: "Journeys", noun: "journey" });
    // A document may name itself, over its mode's noun.
    journeys.list = [...journeys.list, { id: "plain", label: "Plain", noun: "flow" }];
    element.addMode(journeys);

    element.selectDocument("journeys", "short");
    await until(() => element.mode === "journeys");
    expect(label(element)).toMatchObject({ name: "SHORT", kind: "Journey", menu: true });
    // The label's tooltip names what it opens; it carries no aria-label over its own words.
    expect(menuButton(element).title).toBe("Journey options");
    expect(menuButton(element).hasAttribute("aria-label")).toBe(false);
    menuButton(element).click();
    expect(menuPopover(element).getAttribute("aria-label")).toBe("Journey options");
    menuPopover(element).querySelector<HTMLElement>('[data-document-action="rename"]')!.click();
    expect(shadow(element).querySelector("[data-document-rename]")!.getAttribute("aria-label")).toBe("Journey name");
    shadow(element)
      .querySelector("[data-document-rename]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    // The delete confirmation names the document and says what goes, in the mode's words; Cancel keeps it.
    menuButton(element).click();
    menuPopover(element).querySelector<HTMLElement>('[data-document-action="remove"]')!.click();
    const note = menuPopover(element).querySelector<HTMLElement>("[data-remove-note]")!;
    expect(note.querySelector("strong")!.textContent).toBe('Delete "SHORT"');
    expect(note.textContent).toContain("The journey goes, with its translations. Undo brings it back.");
    note.querySelector<HTMLElement>("[data-document-remove-keep]")!.click();
    expect(menuPopover(element).hidden).toBe(true);
    expect(element.mode).toBe("journeys");

    // The document's own word wins over its mode's.
    element.selectDocument("journeys", "plain");
    await until(() => label(element).name === "Plain");
    expect(label(element).kind).toBe("Flow");
    expect(menuButton(element).title).toBe("Flow options");

    // A mode that names no noun is worded as documents; the PDF designer names "layout", and
    // its kind reads "PDF layout"; another mode's layouts are plain layouts.
    const plain = mount();
    await until(() => documents(plain));
    plain.addMode(documentsMode());
    plain.selectDocument("pdf", "letter");
    await until(() => plain.mode === "pdf");
    expect(label(plain).kind).toBe("Document");
    expect(menuButton(plain).title).toBe("Document options");
    const designer = mount();
    await until(() => documents(designer));
    designer.addMode(documentsMode(["letter"], { noun: "layout" }));
    designer.selectDocument("pdf", "letter");
    await until(() => designer.mode === "pdf");
    expect(label(designer).kind).toBe("PDF layout");
    expect(menuButton(designer).title).toBe("Layout options");
    const third = mount();
    await until(() => documents(third));
    third.addMode(documentsMode(["letter"], { id: "layouts", label: "PDF", noun: "layout" }));
    third.selectDocument("layouts", "letter");
    await until(() => third.mode === "layouts");
    expect(label(third).kind).toBe("Layout");
    expect(menuButton(third).title).toBe("Layout options");
  });

  it("starts a new document in the mode asked for, through the guard, of the kind asked for, and refuses a mode that cannot add", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode(["letter"], { noun: "layout" });
    const journeys = documentsMode(["short"], { id: "journeys", label: "Journeys", noun: "journey" });
    element.addMode(pdf);
    element.addMode(journeys);

    // From the form, unsaved edits are settled before the page moves to the mode and it adds.
    element.controller.select("fullName");
    element.controller.setDraftProperty("fullName", "label", "Full name, edited");
    expect(element.newDocument("pdf")).toBe(true);
    expect(element.controller.unsavedChangesPrompt()).toBeTruthy();
    expect(element.mode).toBe("form");
    expect(pdf.added).toBe(0);
    element.controller.answerUnsavedChangesPrompt("discard");
    await until(() => pdf.added === 1);
    expect(element.mode).toBe("pdf");
    expect(label(element).name).toBe("layout 1");

    // Another mode's: the page moves there; asked for no kind, the mode offers every kind.
    expect(element.newDocument("journeys")).toBe(true);
    await until(() => journeys.added === 1);
    expect(element.mode).toBe("journeys");
    expect(journeys.kinds).toEqual([undefined]);
    // The mode on the page adds straight away, of the kind asked for.
    expect(element.newDocument("journeys", "copy")).toBe(true);
    expect(journeys.added).toBe(2);
    expect(journeys.kinds).toEqual([undefined, "copy"]);
    expect(pdf.added).toBe(1);

    // A mode with no add, one not registered, and one the host keeps off the bar cannot add.
    expect(element.newDocument("form")).toBe(false);
    expect(element.newDocument("missing")).toBe(false);
    element.hiddenModeIds = ["pdf"];
    expect(element.newDocument("pdf")).toBe(false);
    expect(pdf.added).toBe(1);
  });

  it("anchors a new document's add on the label for the mode on the page, and starts it from the overview from another", async () => {
    const element = mount();
    await until(() => documents(element));
    const journeys = documentsMode(["short"], { id: "journeys", label: "Journeys", noun: "journey" });
    element.addMode(journeys);
    element.selectDocument("journeys", "short");
    await until(() => element.mode === "journeys");

    // On the mode's own page, the label the add is handed is the one drawn.
    const before = face(element);
    element.newDocument("journeys");
    expect(journeys.anchors).toEqual([before]);
    expect(journeys.anchorsOnPage).toEqual([true]);

    // Asked from the form, the add starts from the mode's overview with the form still on the
    // page, anchored on nothing; the document it makes then opens.
    element.setMode("form");
    await until(() => element.mode === "form");
    element.newDocument("journeys");
    await until(() => journeys.added === 2);
    expect(element.workspace).toBe("journeys");
    expect(journeys.anchors[1]).toBeUndefined();
    await until(() => element.mode === "journeys");
  });

  it("marks the default document with a pill on the label, leaving its name its name", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode();
    element.addMode(pdf);
    element.selectDocument("pdf", "letter");
    await until(() => element.mode === "pdf");
    expect(label(element)).toMatchObject({ name: "LETTER", badges: ["Default"] });
    element.selectDocument("pdf", "a4");
    await until(() => pdf.selected === "a4");
    expect(label(element)).toMatchObject({ name: "A4", badges: [] });
    // The pill moves with the default.
    pdf.documents!.setDefault!("a4");
    expect(label(element)).toMatchObject({ name: "A4", badges: ["Default"] });
    element.selectDocument("pdf", "letter");
    await until(() => pdf.selected === "letter");
    expect(label(element)).toMatchObject({ name: "LETTER", badges: [] });
  });

  it("puts the form back when the mode on the page loses its last document, and names a mode with none on the label", async () => {
    const element = mount();
    await until(() => documents(element));
    const journeys = documentsMode(["short"], { id: "journeys", label: "Journeys", noun: "journey", removeToZero: true });
    element.addMode(journeys);
    element.selectDocument("journeys", "short");
    await until(() => element.mode === "journeys");
    const modeChanges: BuilderModeChangeDetail[] = [];
    element.addEventListener("builder-mode-change", (event) => modeChanges.push((event as CustomEvent<BuilderModeChangeDetail>).detail));
    menuButton(element).click();
    menuPopover(element).querySelector<HTMLElement>('[data-document-action="remove"]')!.click();
    menuPopover(element).querySelector<HTMLElement>('[data-document-action="remove"][data-confirm]')!.click();
    await until(() => element.mode === "form");
    expect(modeChanges.at(-1)).toEqual({ mode: "form", previous: "journeys" });
    expect(element.activeController).toBe(element.controller);
    expect(element.getAttribute("mode")).toBe("form");
    expect(label(element).name).toBe("Sample");

    // The mode stays, so it can still be reached...
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "journeys"]);
    // ...and opened with none, it shows its workspace's overview instead, the form still on the page.
    expect(element.setMode("journeys")).toBe(true);
    expect(element.mode).toBe("form");
    expect(element.workspace).toBe("journeys");
    // Adding the first document from there puts it on the page.
    expect(element.newDocument("journeys")).toBe(true);
    await until(() => journeys.list.length === 1);
    await until(() => label(element).name === "journey 1");
    expect(label(element).kind).toBe("Journey");
    expect(element.mode).toBe("journeys");
  });

  it("reads and writes a mode's targeted rule in the node's configuration, never its rules, with the Rules tab per node type", async () => {
    const element = mount();
    await until(() => documents(element));
    const when = {
      key: "when",
      label: "Show this note when",
      description: "Reads the form's answers.",
      kind: "condition" as const,
      target: { propertyPath: "when" }
    };
    const notes = notesMode({
      inspector: {
        rules: {
          descriptors: (type) => (type === "text" ? [when] : []),
          fieldOptions: () => [{ value: "fullName", label: "Full name (fullName)" }],
          note: "Conditions read the form's answers by id."
        }
      }
    });
    element.addMode(notes);
    element.setMode("notes");
    await until(() => element.mode === "notes");
    const propertiesRoot = (): ShadowRoot => shadow(element).querySelector("datum-builder-properties")!.shadowRoot!;
    const tabIds = (): string[] => [...propertiesRoot().querySelectorAll<HTMLElement>("[data-inspector-tab]")].map((tab) => tab.dataset.inspectorTab!);
    const activeTab = (): string | undefined => propertiesRoot().querySelector<HTMLElement>(".inspector-tab.active")?.dataset.inspectorTab;

    const controller = element.activeController;
    controller.add("text", "notes-root", "content");
    const noteId = controller.selectedComponentId()!;
    expect(tabIds()).toEqual(["properties", "rules", "json"]);
    propertiesRoot().querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
    expect(propertiesRoot().querySelector(".rules-note")!.textContent).toBe("Conditions read the form's answers by id.");
    expect([...propertiesRoot().querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection)).toEqual(["when"]);
    expect(propertiesRoot().querySelector(".rule-desc")!.textContent).toBe("Reads the form's answers.");
    propertiesRoot().querySelector<HTMLElement>('[data-rule="when"][data-rule-mode="formula"]')!.click();
    // The box offers what the mode says (the "Try one" chips), not the tree's own components.
    const tries = [...propertiesRoot().querySelectorAll<HTMLElement>('[data-rule="when"][data-rule-try]')].map((entry) => entry.dataset.ruleTry!);
    expect(tries.join(" ")).toContain("fullName");
    expect(tries.join(" ")).not.toContain(noteId);
    const box = propertiesRoot().querySelector<HTMLTextAreaElement>('[data-rule="when"][data-rule-formula]')!;
    box.value = "fullName";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // Written as the formula string, into the configuration the descriptor names.
    expect(controller.draftProperty(noteId, "when")).toBe("fullName");
    expect(controller.draftRules(noteId)).toBeUndefined();
    propertiesRoot().querySelector<HTMLElement>("[data-inspector-save]")!.click();
    const saved = controller.snapshot().children!.content!.find((node) => node.id === noteId)!;
    expect((saved.configuration as { when?: unknown }).when).toBe("fullName");
    expect(saved.rules).toBeUndefined();
    // Configuration, not rules: the canvas hides nothing for it.
    const canvas = shadow(element).querySelector("datum-builder-canvas") as HTMLElement & { hiddenComponentIds(): ReadonlySet<string> };
    expect(canvas.hiddenComponentIds().size).toBe(0);
    // It reads back from the configuration, as written.
    expect(propertiesRoot().querySelector<HTMLTextAreaElement>('[data-rule="when"][data-rule-formula]')!.value).toBe("fullName");

    // A node type offered no rules has no Rules tab; a panel sitting on Rules moves to Properties.
    controller.add("number", "notes-root", "content");
    expect(tabIds()).toEqual(["properties", "json"]);
    expect(activeTab()).toBe("properties");
    // The mode's root (type "form" here) is offered none either: the Form panel has no Rules tab.
    shadow(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    const formPanel = shadow(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    expect([...formPanel.querySelectorAll<HTMLElement>("[data-inspector-tab]")].map((tab) => tab.dataset.inspectorTab)).toEqual(["properties", "json"]);

    // Back on the form, the engine's own rules again.
    element.mode = "form";
    await until(() => element.mode === "form");
    element.controller.select("fullName");
    expect(tabIds()).toEqual(["properties", "rules", "json"]);
    propertiesRoot().querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
    expect(propertiesRoot().querySelector('[data-rule-section="visibleWhen"]')).toBeTruthy();
    expect(propertiesRoot().querySelector(".rules-note")!.innerHTML).toContain("<code>row.</code>");
  });

  it("lists the Variables panel in the syntax the mode on the page asks for", async () => {
    const element = mount();
    await until(() => documents(element));
    const variables = shadow(element).querySelector("datum-builder-variables-panel") as HTMLElement & { syntax: string };
    // The Variables panel is a lazy chunk: it has a syntax once it is first opened.
    element.panel = "variables";
    await until(() => (variables as { syntax?: string }).syntax !== undefined);
    expect(variables.syntax).toBe("rules");
    const conditions = notesMode();
    conditions.variables = "conditions";
    element.addMode(conditions);
    element.addMode(documentsMode());
    element.setMode("notes");
    await until(() => element.mode === "notes");
    expect(variables.syntax).toBe("conditions");
    element.selectDocument("pdf", "letter");
    await until(() => element.mode === "pdf");
    expect(variables.syntax).toBe("placeholders");
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(variables.syntax).toBe("rules");
  });

  it("draws a mode's rows on the Form panel on the form's tab, drafted with the form's settings and saved with them", async () => {
    const element = mount();
    await until(() => documents(element));
    const listeners = new Set<() => void>();
    let opensAs = "form";
    let shown = true;
    const writes: string[] = [];
    const row = {
      id: "notes.opensAs",
      label: "Opens as",
      description: "What a person sees first.",
      choices: [
        { value: "form", label: "The whole form" },
        { value: "notes", label: "Notes" }
      ],
      note: "Default notes: Notes",
      open: { label: "Open notes" },
      get: () => opensAs,
      set: (value: string) => {
        writes.push(value);
        opensAs = value;
      }
    };
    const notes = notesMode();
    notes.formSettings = {
      title: "Notes",
      rows: () => (shown ? [row] : []),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    element.addMode(notes);
    shadow(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    const formPanel = (): ShadowRoot => shadow(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    const section = (): HTMLElement | null => formPanel().querySelector<HTMLElement>('[data-mode-settings="notes"]');
    expect(section()!.querySelector("summary")!.textContent).toBe("Notes");
    const select = (): HTMLSelectElement => formPanel().querySelector<HTMLSelectElement>('[data-root-setting="notes.opensAs"]')!;
    expect(select().value).toBe("form");
    expect(formPanel().querySelector('[data-root-setting-note="notes.opensAs"]')!.textContent).toBe("Default notes: Notes");

    // A choice is a draft on the form root: Unsaved, nothing written until Save.
    select().value = "notes";
    select().dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(element.controller.hasPendingChanges("root")).toBe(true);
    expect(formPanel().querySelector(".dirty-flag")).toBeTruthy();
    expect(writes).toEqual([]);
    formPanel().querySelector<HTMLElement>("[data-inspector-cancel]")!.click();
    expect(select().value).toBe("form");
    select().value = "notes";
    select().dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    formPanel().querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(writes).toEqual(["notes"]);
    expect(element.controller.hasPendingChanges("root")).toBe(false);
    expect(select().value).toBe("notes");

    // The row's button opens its mode.
    formPanel().querySelector<HTMLElement>('[data-root-setting-open="notes"]')!.click();
    await until(() => element.mode === "notes");
    // Not on another mode's tab: the Form panel there is that mode's root.
    expect(section()).toBeNull();
    element.mode = "form";
    await until(() => element.mode === "form");
    expect(section()).toBeTruthy();

    // No rows, no section; the mode says when through its subscription.
    shown = false;
    for (const listener of listeners) {
      listener();
    }
    expect(section()).toBeNull();
    element.removeMode("notes");
    expect(listeners.size).toBe(0);
  });

  it("moves a document up and down from its menu, off at the ends, and draws a badge beside its name on the label", async () => {
    const element = mount();
    await until(() => documents(element));
    const pdf = documentsMode(["letter", "a4", "legal"]);
    const moves: Array<[string, number]> = [];
    pdf.documents!.move = (id, offset) => {
      moves.push([id, offset]);
      const next = [...pdf.list];
      const at = next.findIndex((document) => document.id === id);
      const [moved] = next.splice(at, 1);
      next.splice(at + offset, 0, moved!);
      pdf.list = next;
      pdf.notify();
    };
    pdf.list = pdf.list.map((document) => (document.id === "a4" ? { ...document, badge: "Conditional" } : document));
    element.addMode(pdf);
    element.selectDocument("pdf", "a4");
    await until(() => element.mode === "pdf");

    // The badge is drawn beside the name, not written into it.
    expect(label(element)).toMatchObject({ name: "A4", badges: ["Conditional"] });
    element.selectDocument("pdf", "letter");
    await until(() => pdf.selected === "letter");
    expect(label(element)).toMatchObject({ name: "LETTER", badges: ["Default"] });
    // Beside the Default pill, the pill first.
    pdf.list = pdf.list.map((document) => (document.id === "letter" ? { ...document, badge: "Conditional" } : document));
    pdf.notify();
    expect(label(element)).toMatchObject({ name: "LETTER", badges: ["Default", "Conditional"] });

    const menu = shadow(element).querySelector<HTMLElement>("[data-document-menu-popover]")!;
    const item = (action: string): HTMLButtonElement => menu.querySelector<HTMLButtonElement>(`[data-document-action="${action}"]`)!;
    shadow(element).querySelector<HTMLElement>("[data-document-menu]")!.click();
    expect(item("move-up").textContent).toBe("Move up");
    expect(item("move-up").disabled).toBe(true);
    expect(item("move-down").disabled).toBe(false);
    // Each move item reads where the document stands.
    expect(menu.querySelector("[data-document-place]")!.textContent).toBe("LETTER is document 1 of 3");
    item("move-down").click();
    expect(moves).toEqual([["letter", 1]]);
    expect(pdf.list.map((document) => document.id)).toEqual(["a4", "letter", "legal"]);
    // The menu is back, on the same item, for another step; at the far end the item is off.
    expect(menu.hidden).toBe(false);
    expect(shadow(element).activeElement).toBe(item("move-down"));
    expect(menu.querySelector("[data-document-place]")!.textContent).toBe("LETTER is document 2 of 3");
    item("move-down").click();
    expect(moves).toEqual([
      ["letter", 1],
      ["letter", 1]
    ]);
    expect(item("move-down").disabled).toBe(true);
    expect(item("move-up").disabled).toBe(false);
    item("move-up").click();
    expect(moves.at(-1)).toEqual(["letter", -1]);
    expect(pdf.list.map((document) => document.id)).toEqual(["a4", "letter", "legal"]);
    // Moving it leaves the label as it was: the same document, by name.
    expect(label(element)).toMatchObject({ name: "LETTER", badges: ["Default", "Conditional"] });
  });

  it("draws a mode's read-only rows on the Form panel: words and a way to the mode, nothing drafted", async () => {
    const element = mount();
    await until(() => documents(element));
    const listeners = new Set<() => void>();
    let words = "Chosen by the answers: 1. Regional copy. Otherwise: Standard.";
    const notes = notesMode();
    notes.formSettings = {
      title: "Notes",
      rows: () => [],
      readOnlyRows: () => [
        {
          id: "notes.order",
          label: "Which note prints",
          get note() {
            return words;
          },
          open: { label: "Open notes" }
        }
      ],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    element.addMode(notes);
    shadow(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    const formPanel = (): ShadowRoot => shadow(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    const section = (): HTMLElement | null => formPanel().querySelector<HTMLElement>('[data-mode-settings="notes"]');
    expect(section()!.querySelector("summary")!.textContent).toBe("Notes");
    expect(section()!.querySelector('[data-root-setting-readonly="notes.order"]')!.textContent).toBe("Which note prints");
    expect(section()!.querySelector('[data-root-setting-note="notes.order"]')!.textContent).toBe(words);
    // No control, so nothing to draft: the form's Save and "Unsaved" never count it.
    expect(section()!.querySelector("select, input")).toBeNull();
    expect(element.controller.hasPendingChanges("root")).toBe(false);

    // Its words are read on every paint.
    words = "No note has a condition.";
    for (const listener of listeners) {
      listener();
    }
    expect(section()!.querySelector('[data-root-setting-note="notes.order"]')!.textContent).toBe(words);

    section()!.querySelector<HTMLElement>('[data-root-setting-open="notes"]')!.click();
    await until(() => element.mode === "notes");
    element.removeMode("notes");
    expect(listeners.size).toBe(0);
  });
});

