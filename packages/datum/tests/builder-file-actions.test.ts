import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import "../src/builder.js";
import {
  BUILDER_HOST_CONTROL_STYLES,
  DatumBuilderElement,
  svgIconSet,
  type BuilderFileActionDetail,
  type BuilderFileActions,
  type ComponentNode
} from "../src/builder.js";

import { until } from "./helpers.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

/*
 * An environment without `URL.createObjectURL` is the "downloads are unavailable" case, and
 * jsdom's URL class inherits Node's static one (which only takes Node's Blob, so it is never
 * the page's). Each test starts with an own `undefined` shadowing it: the cases that stub a
 * download define their own over it, and their `delete` would only uncover the inherited one,
 * which the next test's shadow covers again.
 */
const hadOwnCreateObjectURL = Object.prototype.hasOwnProperty.call(URL, "createObjectURL");
const ownCreateObjectURL = hadOwnCreateObjectURL ? (URL as unknown as Record<string, unknown>).createObjectURL : undefined;

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: undefined, configurable: true, writable: true });
});

afterAll(() => {
  if (hadOwnCreateObjectURL) Object.defineProperty(URL, "createObjectURL", { value: ownCreateObjectURL, configurable: true, writable: true });
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function emptyRoot(): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: [] } };
}

function mount(root: ComponentNode = formRoot(), actions?: BuilderFileActions): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: root, componentTypes: [{ type: "text", label: "Text" }] };
  if (actions) {
    element.fileActions = actions;
  }
  document.body.append(element);
  return element;
}

function shadow(element: DatumBuilderElement): ShadowRoot {
  return element.shadowRoot!;
}

function q<T extends HTMLElement = HTMLElement>(element: DatumBuilderElement, selector: string): T {
  return shadow(element).querySelector<T>(selector)!;
}

/** The file menu's items on show, by their text (which names them), in the order the menu draws them. */
function shownFileItems(element: DatumBuilderElement): string[] {
  // The file items alone: Dark mode shares the menu but is the shell's own.
  return [...q(element, "[data-file-menu-list]").querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([hidden]):not([data-file-scheme])")].map(
    (item) => item.querySelector(".file-item-label")?.textContent ?? ""
  );
}

function confirmDialog(element: DatumBuilderElement): HTMLDialogElement {
  return q<HTMLDialogElement>(element, "[data-file-confirm]");
}

function fileError(element: DatumBuilderElement): HTMLElement {
  return q(element, "[data-file-error]");
}

/** Records the `builder-file-action` events heard on the document (the event bubbles and is composed). */
function fileActionEvents(): BuilderFileActionDetail[] {
  const heard: BuilderFileActionDetail[] = [];
  document.addEventListener("builder-file-action", (event) => heard.push((event as CustomEvent<BuilderFileActionDetail>).detail));
  return heard;
}

/** Chooses a file in the shell's hidden picker, as the browser would: files set, then a change. */
function chooseFile(element: DatumBuilderElement, file: File): void {
  const input = q<HTMLInputElement>(element, "[data-file-input]");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("<datum-builder> file actions on the bar", () => {
  it("shows a menu item only for each action the host supplies, New, Open, Download in that order, in one File menu last on the bar", async () => {
    const element = mount();
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const group = q(element, "[data-file-actions]");
    const sep = q(element, "[data-host-sep]");
    // None supplied: the raw element shows no file item (the menu stays for Dark mode), and nothing leads undo/redo.
    expect(group.hidden).toBe(false);
    expect(shownFileItems(element)).toEqual([]);
    expect(sep.hidden).toBe(true);
    // The group is the last thing on the bar, after the host's places at its end.
    const barEnd = q(element, ".bar-end");
    expect(barEnd.lastElementChild).toBe(group);
    expect(group.previousElementSibling?.matches('slot[name="account"]')).toBe(true);
    // One menu button, and the menu it controls, shut.
    const toggle = q<HTMLButtonElement>(element, "[data-file-menu]");
    const menu = q(element, "[data-file-menu-list]");
    // Three vertical dots, named Menu (it holds Dark mode as well as the file items).
    expect(toggle.textContent).toBe("");
    expect(toggle.getAttribute("aria-label")).toBe("Menu");
    expect(toggle.dataset.tip).toBe("Menu");
    expect(menu.getAttribute("aria-label")).toBe("Menu");
    expect(toggle.querySelectorAll("svg circle")).toHaveLength(3);
    expect(toggle.classList.contains("bar-btn")).toBe(true);
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("file-menu");
    expect(menu.id).toBe("file-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.hidden).toBe(true);

    element.fileActions = { download: () => ({ name: "form.json", text: "{}" }) };
    expect(group.hidden).toBe(false);
    expect(shownFileItems(element)).toEqual(["Download form"]);
    // The file menu brings no divider at the bar's start: that is the host's leading slot's alone.
    expect(sep.hidden).toBe(true);

    element.fileActions = { new: () => undefined, open: () => () => undefined, download: () => ({ name: "form.json", text: "{}" }) };
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);
    // No Save unless the host gives one, and no rule under it then.
    expect(q(element, "[data-file-save]").hidden).toBe(true);
    expect(q(element, "[data-file-save-sep]").hidden).toBe(true);
    // Menu items, named by their text: no aria-label, not bar buttons, reached by the arrows rather than Tab.
    for (const selector of ["[data-file-new]", "[data-file-open]", "[data-file-download]"]) {
      const item = q(element, selector);
      expect(item.getAttribute("role"), selector).toBe("menuitem");
      expect(item.hasAttribute("aria-label"), selector).toBe(false);
      expect(item.classList.contains("file-item"), selector).toBe(true);
      expect(item.classList.contains("bar-btn"), selector).toBe(false);
      expect(item.getAttribute("tabindex"), selector).toBe("-1");
    }
    // Each is drawn from the icon set, under its own chrome name.
    expect(q(element, '[data-file-new] [data-glyph="new-form"] svg')).toBeTruthy();
    expect(q(element, '[data-file-open] [data-glyph="open-form"] svg')).toBeTruthy();
    expect(q(element, '[data-file-download] [data-glyph="download-form"] svg')).toBeTruthy();
    // The picker is in the shadow root, hidden, for JSON files.
    const input = q<HTMLInputElement>(element, "[data-file-input]");
    expect(input.type).toBe("file");
    expect(input.hidden).toBe(true);
    expect(input.accept).toBe("application/json,.json");
    expect(input.getAttribute("aria-label")).toBe("Form file");

    element.fileActions = undefined;
    // The menu stays on the bar for Dark mode; the file items are gone from it.
    expect(group.hidden).toBe(false);
    expect(shownFileItems(element)).toEqual([]);
    expect(sep.hidden).toBe(true);
    // The host's own leading control brings the divider.
    const save = document.createElement("button");
    save.slot = "toolbar-start";
    save.textContent = "Save";
    element.append(save);
    await until(() => !sep.hidden);
  });

  it("keeps the actions across a re-connect, and repaints their glyphs with a new icon set", async () => {
    const element = mount(formRoot(), { new: () => undefined });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    element.remove();
    document.body.append(element);
    expect(shownFileItems(element)).toEqual(["New form"]);
    element.icons = svgIconSet("acme", { "new-form": { viewBox: "0 0 1 1", body: "<!--acme-new-->" } });
    expect(q(element, '[data-file-new] [data-glyph="new-form"]').innerHTML).toContain("<!--acme-new-->");
  });

  it("asks before New replaces a form with components, and runs it only on OK", async () => {
    const heard = fileActionEvents();
    const created = vi.fn();
    const element = mount(formRoot(), { new: created });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const dialog = confirmDialog(element);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(dialog.getAttribute("role")).toBe("alertdialog");

    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(created).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(q(element, "[data-file-confirm-message]").textContent).toBe(
      "Start a new form in place of this one? Its components, languages and layouts are replaced, and this can't be undone."
    );
    expect(q(element, "[data-file-confirm-ok]").textContent).toBe("Start a new form");
    expect(q(element, "[data-file-confirm-cancel]").textContent).toBe("Cancel");
    // Focus starts on Cancel: the destructive answer takes a deliberate move.
    expect(shadow(element).activeElement).toBe(q(element, "[data-file-confirm-cancel]"));

    q<HTMLButtonElement>(element, "[data-file-confirm-cancel]").click();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(created).not.toHaveBeenCalled();
    expect(heard).toEqual([]);

    // Escape is Cancel too.
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(dialog.hasAttribute("open")).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(created).not.toHaveBeenCalled();

    q<HTMLButtonElement>(element, "[data-file-new]").click();
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(created).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([{ action: "new" }]);
  });

  it("runs New at once on a form with nothing in it: there is nothing to lose", async () => {
    const heard = fileActionEvents();
    const created = vi.fn();
    const element = mount(emptyRoot(), { new: created });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(created).toHaveBeenCalledTimes(1);
    expect(confirmDialog(element).hasAttribute("open")).toBe(false);
    expect(heard).toEqual([{ action: "new" }]);
  });

  it("asks before New on a form with no components but settings, languages, or what the host says it holds", async () => {
    // A title (or a header, a footer) on the form is work a New would lose.
    const titled = vi.fn();
    const withTitle = mount({ ...emptyRoot(), configuration: { title: "Titled" } }, { new: titled });
    await until(() => shadow(withTitle).querySelector('[data-shell="bar"]'));
    q<HTMLButtonElement>(withTitle, "[data-file-new]").click();
    expect(confirmDialog(withTitle).hasAttribute("open")).toBe(true);
    expect(titled).not.toHaveBeenCalled();
    q<HTMLButtonElement>(withTitle, "[data-file-confirm-cancel]").click();

    // A setting cleared on the Form panel can stay as a key with no value: nothing set, no question.
    const cleared = vi.fn();
    const withCleared = mount({ ...emptyRoot(), configuration: { title: undefined } }, { new: cleared });
    await until(() => shadow(withCleared).querySelector('[data-shell="bar"]'));
    q<HTMLButtonElement>(withCleared, "[data-file-new]").click();
    expect(confirmDialog(withCleared).hasAttribute("open")).toBe(false);
    expect(cleared).toHaveBeenCalledTimes(1);

    // Languages too.
    const bilingual = vi.fn();
    const withLocales = document.createElement("datum-builder") as DatumBuilderElement;
    withLocales.options = {
      initialRoot: emptyRoot(),
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }
    };
    withLocales.fileActions = { new: bilingual };
    document.body.append(withLocales);
    await until(() => shadow(withLocales).querySelector('[data-shell="bar"]'));
    q<HTMLButtonElement>(withLocales, "[data-file-new]").click();
    expect(confirmDialog(withLocales).hasAttribute("open")).toBe(true);
    expect(bilingual).not.toHaveBeenCalled();
    q<HTMLButtonElement>(withLocales, "[data-file-confirm-cancel]").click();

    // An empty tree, but the host holds more (PDF layouts, journeys): its isEmpty says so.
    const held = vi.fn();
    const isEmpty = vi.fn(() => false);
    const hostHolds = mount(emptyRoot(), { new: held, isEmpty });
    await until(() => shadow(hostHolds).querySelector('[data-shell="bar"]'));
    q<HTMLButtonElement>(hostHolds, "[data-file-new]").click();
    expect(isEmpty).toHaveBeenCalledTimes(1);
    expect(confirmDialog(hostHolds).hasAttribute("open")).toBe(true);
    q<HTMLButtonElement>(hostHolds, "[data-file-confirm-ok]").click();
    expect(held).toHaveBeenCalledTimes(1);
    // isEmpty is not a button of its own.
    expect(shownFileItems(hostHolds)).toEqual(["New form"]);
  });

  it("holds a file action behind the unsaved-edits guard while a draft is pending", async () => {
    const created = vi.fn();
    const downloaded = vi.fn(() => ({ name: "form.json", text: "{}" }));
    const element = mount(formRoot(), { new: created, download: downloaded });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const controller = element.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Edited");
    expect(controller.hasPendingChanges("fullName")).toBe(true);

    // New: held, no question of its own yet.
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: "fullName", action: "leave" });
    expect(confirmDialog(element).hasAttribute("open")).toBe(false);
    expect(created).not.toHaveBeenCalled();
    // Stay drops it; nothing happens.
    controller.answerUnsavedChangesPrompt("stay");
    expect(confirmDialog(element).hasAttribute("open")).toBe(false);
    expect(created).not.toHaveBeenCalled();

    // Download: held too, and carried on once the draft is dealt with.
    const created2 = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:held"), configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      q<HTMLButtonElement>(element, "[data-file-download]").click();
      expect(downloaded).not.toHaveBeenCalled();
      expect(controller.unsavedChangesPrompt()?.action).toBe("leave");
      controller.answerUnsavedChangesPrompt("save");
      expect(downloaded).toHaveBeenCalledTimes(1);
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }

    // New again, with a draft, answered with Discard: the question comes after the guard.
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Edited again");
    element.fileActions = { new: created2 };
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(confirmDialog(element).hasAttribute("open")).toBe(false);
    controller.answerUnsavedChangesPrompt("discard");
    expect(confirmDialog(element).hasAttribute("open")).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(created2).toHaveBeenCalledTimes(1);
    expect(created).not.toHaveBeenCalled();
  });

  it("opens a chosen file: reads it, hands it to the host to check, asks, and applies on OK", async () => {
    const heard = fileActionEvents();
    const clicked = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const seen: Array<{ name: string; text: string }> = [];
    const applied = vi.fn();
    const element = mount(formRoot(), {
      open: (file) => {
        seen.push(file);
        return applied;
      }
    });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));

    q<HTMLButtonElement>(element, "[data-file-open]").click();
    // The picker opens inside the click, the author's gesture.
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked.mock.contexts[0]).toBe(q(element, "[data-file-input]"));

    chooseFile(element, new File(['{"id":"picked"}'], "picked.json", { type: "application/json" }));
    await until(() => confirmDialog(element).hasAttribute("open"));
    expect(seen).toEqual([{ name: "picked.json", text: '{"id":"picked"}' }]);
    // Cleared, so the same file can be chosen again.
    expect(q<HTMLInputElement>(element, "[data-file-input]").value).toBe("");
    expect(q(element, "[data-file-confirm-message]").textContent).toBe('Replace this form with "picked.json"? This can\'t be undone.');
    expect(q(element, "[data-file-confirm-ok]").textContent).toBe("Replace");
    expect(applied).not.toHaveBeenCalled();

    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([{ action: "open", name: "picked.json" }]);
  });

  it("shows a refused file's message on the bar, replaces it with the next, clears it on Dismiss and on a later success", async () => {
    const heard = fileActionEvents();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const applied = vi.fn();
    const element = mount(formRoot(), {
      open: async (file) => {
        if (file.name === "bad.json") {
          throw new Error("it is not JSON: Unexpected token o");
        }
        if (file.name === "worse.json") {
          throw new Error("the root must be a form");
        }
        return applied;
      }
    });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const alert = fileError(element);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.hidden).toBe(true);

    chooseFile(element, new File(["not json"], "bad.json"));
    await until(() => !alert.hidden);
    expect(q(element, "[data-file-error-message]").textContent).toBe('Could not open "bad.json": it is not JSON: Unexpected token o.');
    expect(confirmDialog(element).hasAttribute("open")).toBe(false);

    chooseFile(element, new File(["{}"], "worse.json"));
    await until(() => q(element, "[data-file-error-message]").textContent?.includes("worse.json"));
    expect(q(element, "[data-file-error-message]").textContent).toBe('Could not open "worse.json": the root must be a form.');

    // Cut short on the bar, whole in its title.
    expect(q(element, "[data-file-error-message]").title).toBe('Could not open "worse.json": the root must be a form.');

    const dismiss = q<HTMLButtonElement>(element, "[data-file-error-dismiss]");
    expect(dismiss.textContent).toBe("Dismiss");
    expect(dismiss.classList.contains("bar-btn")).toBe(true);
    dismiss.click();
    expect(alert.hidden).toBe(true);
    expect(q(element, "[data-file-error-message]").hasAttribute("title")).toBe(false);

    chooseFile(element, new File(["{}"], "worse.json"));
    await until(() => !alert.hidden);
    chooseFile(element, new File(["{}"], "good.json"));
    await until(() => confirmDialog(element).hasAttribute("open"));
    // Choosing another file clears the earlier refusal at once (it was about the old file).
    expect(alert.hidden).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(alert.hidden).toBe(true);
    expect(heard).toEqual([{ action: "open", name: "good.json" }]);
  });

  it("hands focus on Dismiss back to the item the message was about while the menu shows it, else to the File button", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount(formRoot(), {
      new: () => undefined,
      open: () => {
        throw new Error("it is not a form");
      },
      download: () => ({ name: "form.json", text: "{}" })
    });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const toggle = q<HTMLButtonElement>(element, "[data-file-menu]");
    const menu = q(element, "[data-file-menu-list]");
    const focused = (): Element | null => shadow(element).activeElement;

    // A refused file while the menu is open: Open, not New (the first item), takes focus.
    toggle.click();
    expect(menu.hidden).toBe(false);
    chooseFile(element, new File(["{}"], "refused.json"));
    await until(() => !fileError(element).hidden);
    q<HTMLButtonElement>(element, "[data-file-error-dismiss]").click();
    expect(fileError(element).hidden).toBe(true);
    expect(focused()).toBe(q(element, "[data-file-open]"));

    // The item it was about since put away: the File button takes it.
    chooseFile(element, new File(["{}"], "refused.json"));
    await until(() => !fileError(element).hidden);
    element.fileActions = { new: () => undefined, download: () => ({ name: "form.json", text: "{}" }) };
    q<HTMLButtonElement>(element, "[data-file-error-dismiss]").click();
    expect(focused()).toBe(toggle);
  });

  // A shut menu's items are out of sight: Dismiss hands focus to the File button instead.
  it("hands focus on Dismiss to the File button when the menu is shut, the item out of sight", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount(formRoot(), {
      new: () => undefined,
      open: () => {
        throw new Error("it is not a form");
      },
      download: () => ({ name: "form.json", text: "{}" })
    });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    const toggle = q<HTMLButtonElement>(element, "[data-file-menu]");
    const menu = q(element, "[data-file-menu-list]");
    const focused = (): Element | null => shadow(element).activeElement;

    // A refused file with the menu shut: the File button takes it.
    chooseFile(element, new File(["{}"], "refused.json"));
    await until(() => !fileError(element).hidden);
    q<HTMLButtonElement>(element, "[data-file-error-dismiss]").click();
    expect(focused()).toBe(toggle);

    // Downloads unavailable, chosen from the menu (which an item puts away): the File button takes it.
    expect(typeof (URL as unknown as Record<string, unknown>).createObjectURL).not.toBe("function");
    toggle.click();
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(menu.hidden).toBe(true);
    expect(fileError(element).hidden).toBe(false);
    q<HTMLButtonElement>(element, "[data-file-error-dismiss]").click();
    expect(focused()).toBe(toggle);
  });

  it("says so when the chosen file cannot be read", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "error", { value: new DOMException("the disk is gone"), configurable: true });
      setTimeout(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>), 0);
    });
    const open = vi.fn(() => () => undefined);
    const element = mount(formRoot(), { open });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    chooseFile(element, new File(["{}"], "lost.json"));
    await until(() => !fileError(element).hidden);
    expect(q(element, "[data-file-error-message]").textContent).toBe('Could not read "lost.json": the disk is gone.');
    expect(open).not.toHaveBeenCalled();
  });

  it("downloads the host's file as a blob through a temporary link", async () => {
    const heard = fileActionEvents();
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:form";
      }),
      configurable: true,
      writable: true
    });
    // Revoked a moment later: the no-op stays in place after the test, for that late call.
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
    const anchors: Array<{ href: string; download: string; connected: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push({ href: this.href, download: this.download, connected: this.isConnected });
    });
    try {
      const element = mount(formRoot(), {
        download: () => ({ name: "sample-form.json", text: '{\n  "id": "sample-form"\n}\n', type: "application/json" })
      });
      await until(() => shadow(element).querySelector('[data-shell="bar"]'));
      q<HTMLButtonElement>(element, "[data-file-download]").click();
      expect(anchors).toEqual([{ href: "blob:form", download: "sample-form.json", connected: true }]);
      // The link was temporary.
      expect(shadow(element).querySelector("a[download]")).toBeNull();
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.type).toBe("application/json");
      expect(await readBlob(blobs[0]!)).toBe('{\n  "id": "sample-form"\n}\n');
      expect(heard).toEqual([{ action: "download", name: "sample-form.json" }]);
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }
  });

  it("says downloads are unavailable where there are no object URLs", async () => {
    const downloaded = vi.fn(() => ({ name: "form.json", text: "{}" }));
    const element = mount(formRoot(), { download: downloaded });
    await until(() => shadow(element).querySelector('[data-shell="bar"]'));
    expect(typeof (URL as unknown as Record<string, unknown>).createObjectURL).not.toBe("function");
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(fileError(element).hidden).toBe(false);
    expect(q(element, "[data-file-error-message]").textContent).toBe("Downloads are not available here.");
    expect(downloaded).not.toHaveBeenCalled();
  });
});

describe("the builder's look for host controls", () => {
  it("installs its stylesheet once per root: the document, or the shadow root a builder lives in", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    const inDocument = (): number => document.querySelectorAll("style[data-datum-host-controls]").length;
    const first = mount();
    await until(() => shadow(first).querySelector('[data-shell="bar"]'));
    expect(inDocument()).toBe(1);
    const style = document.querySelector("style[data-datum-host-controls]")!;
    expect(style.textContent).toBe(BUILDER_HOST_CONTROL_STYLES);
    expect(document.head.contains(style)).toBe(true);
    // A second builder, and a re-connect, add nothing.
    mount();
    first.remove();
    document.body.append(first);
    expect(inDocument()).toBe(1);

    // A builder inside another element's shadow root styles the controls slotted there, in that root.
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const nested = document.createElement("datum-builder") as DatumBuilderElement;
    nested.options = { initialRoot: formRoot() };
    root.append(nested);
    await until(() => nested.shadowRoot?.querySelector('[data-shell="bar"]'));
    expect(root.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(1);
    const second = document.createElement("datum-builder") as DatumBuilderElement;
    second.options = { initialRoot: formRoot() };
    root.append(second);
    expect(root.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(1);
    expect(inDocument()).toBe(1);
  });

  it("holds every rule to one element's weight, so a host's class wins, and dresses bar buttons, selects and strip launchers from the tokens", () => {
    const css = BUILDER_HOST_CONTROL_STYLES;
    expect(css).toContain(
      ':where(datum-builder, datum-form-builder) > button:where([slot="toolbar-start"], [slot="toolbar"], [slot="canvas-actions"], [slot="history"], [slot="comments"], [slot="publish"], [slot="account"])'
    );
    expect(css).toContain(
      ':where(datum-builder, datum-form-builder) > select:where([slot="toolbar-start"], [slot="toolbar"], [slot="canvas-actions"], [slot="history"], [slot="comments"], [slot="publish"], [slot="account"])'
    );
    expect(css).toContain(':where(datum-builder, datum-form-builder) > button:where([slot="strip"])');
    // Every selector: one type selector, everything else inside :where().
    const selectors = css
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter(Boolean)
      .flatMap((list) => list.split(/,(?![^(]*\))/).map((selector) => selector.trim()));
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      const outside = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
      expect(outside.replace(/\s*>\s*/g, " ").trim(), selector).toMatch(/^(button|select)$/);
    }
    // The states, and colours from tokens only (the studio look: pills on the backdrop).
    expect(css).toContain(":where(:hover:not(:disabled)), ");
    expect(css).toContain("{ background: var(--db-surface-hover); color: var(--db-ink); }");
    expect(css).toContain(':where([aria-pressed="true"])');
    expect(css).toContain(':where([aria-selected="true"])');
    expect(css).toContain("border-radius: var(--db-radius-pill)");
    expect(css).toContain("outline: 2px solid var(--db-focus); outline-offset: 2px;");
    expect(css).toContain(":where([hidden])");
    // The host's primary action, marked data-builder-primary, is the accent pill.
    expect(css).toMatch(/:where\(\[data-builder-primary\]\) \{\s*background: var\(--db-accent\); border-color: var\(--db-accent\); color: var\(--db-accent-ink\);/);
    // No literal colour: every one is a token the slotted control inherits.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgba?\(/);
  });
});
