// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  defineDatumBuilderElement,
  type BuilderFileActionDetail,
  type BuilderFileActions,
  type BuilderSaveContext,
  type BuilderSaveOutcome,
  type DatumBuilderElement
} from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";

/*
 * The shell's Save, split for the browser-assistant tools: the File menu's Save keeps asking about unapplied edits through
 * `requestLeave` before the shared `runSave`; an assistant's `requestSave()` never asks, it is told
 * what is in the way (`held`) and changes nothing, and otherwise runs the same save with
 * `trigger: "agent"`. jsdom applies no shadow CSS: the File menu is asserted on its attributes and
 * text, never on what shows.
 */

defineDatumBuilderElement();

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const LANGUAGES: LocalizationConfiguration = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }], defaultLocale: "en" };

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } }
      ]
    }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function mount(actions?: BuilderFileActions, localization?: LocalizationConfiguration): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }], ...(localization ? { localization } : {}) };
  if (actions) {
    element.fileActions = actions;
  }
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("[data-file-save]"));
  return element;
}

const q = <T extends HTMLElement = HTMLElement>(element: DatumBuilderElement, selector: string): T => element.shadowRoot!.querySelector<T>(selector)!;

/** The `builder-file-action` events heard on the document (the event bubbles and is composed). */
function fileActionEvents(): BuilderFileActionDetail[] {
  const heard: BuilderFileActionDetail[] = [];
  const listener = (event: Event): void => {
    heard.push((event as CustomEvent<BuilderFileActionDetail>).detail);
  };
  document.addEventListener("builder-file-action", listener);
  afterEachRemovals.push(() => document.removeEventListener("builder-file-action", listener));
  return heard;
}
const afterEachRemovals: Array<() => void> = [];
afterEach(() => {
  for (const remove of afterEachRemovals.splice(0)) {
    remove();
  }
});

/** A promise with its settling handed out, for a save the test finishes when it wants. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The shell's private shared save, spied on the instance so the person's path through it is visible. */
function spyRunSave(element: DatumBuilderElement) {
  return vi.spyOn(element as unknown as { runSave(trigger?: "agent"): Promise<BuilderSaveOutcome> }, "runSave");
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Ctrl+S pressed on a shell control, as a browser sends it (bubbling, composed): the key's own
 * route to the File menu's Save, which a click on the item cannot stand in for while the item is
 * disabled (jsdom, like a browser, ignores `click()` on a disabled button).
 */
function pressSave(element: DatumBuilderElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, composed: true, cancelable: true });
  q(element, "[data-undo]").dispatchEvent(event);
  return event;
}

/** A designer's mode put on the page (Journeys or PDF stand-in) with its own controller and one field. */
async function enterDesigner(element: DatumBuilderElement): Promise<BuilderController> {
  const controller = new BuilderController({
    initialRoot: { id: "layout-root", type: "form", configuration: {}, children: { content: [{ id: "layoutField", type: "text", configuration: { label: "On the layout" } }] } }
  });
  element.addMode({ id: "pdf", label: "PDF", controller });
  expect(element.setMode("pdf")).toBe(true);
  // The switch activates the mode asynchronously.
  await until(() => element.activeController === controller);
  return controller;
}

describe("the person's File menu Save (unchanged)", () => {
  it("asks requestLeave first, then runs the shared save once, with the context it always had", async () => {
    const save = vi.fn<(context: BuilderSaveContext) => void>();
    const element = await mount({ save });
    const heard = fileActionEvents();
    const requestLeave = vi.spyOn(element.activeController, "requestLeave");
    const runSave = spyRunSave(element);
    q(element, "[data-file-save]").click();
    expect(requestLeave).toHaveBeenCalledTimes(1);
    expect(runSave).toHaveBeenCalledTimes(1);
    // The person's path: no trigger, so the save's context and the event are what they were.
    expect(runSave).toHaveBeenCalledWith();
    expect(requestLeave.mock.invocationCallOrder[0]!).toBeLessThan(runSave.mock.invocationCallOrder[0]!);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toEqual({ localeChanges: { removed: [], renamed: [] } });
    expect(Object.keys(save.mock.calls[0]![0])).toEqual(["localeChanges"]);
    expect(heard).toEqual([{ action: "save" }]);
    expect(Object.keys(heard[0]!)).toEqual(["action"]);
  });

  it("holds behind the unsaved-edits prompt while a draft is open, and saves once the person answers", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const controller = element.activeController;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Your name");
    const runSave = spyRunSave(element);
    q(element, "[data-file-save]").click();
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: "fullName", action: "leave" });
    expect(runSave).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    controller.answerUnsavedChangesPrompt("discard");
    expect(runSave).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the Saving… latch: busy and disabled while the host's save is pending, one save at a time", async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const element = await mount({ save });
    const heard = fileActionEvents();
    const item = q<HTMLButtonElement>(element, "[data-file-save]");
    item.click();
    expect(item.hasAttribute("aria-busy")).toBe(true);
    expect(item.disabled).toBe(true);
    expect(item.querySelector(".file-item-label")!.textContent).toBe("Saving…");
    // A second Save while pending starts nothing: Ctrl/Cmd+S reaches the File menu's Save past the
    // disabled item (as the palette does), so this is the guard in the Save itself.
    expect(pressSave(element).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
    pending.resolve();
    await flush();
    expect(item.hasAttribute("aria-busy")).toBe(false);
    expect(item.disabled).toBe(false);
    expect(item.querySelector(".file-item-label")!.textContent).toBe("Save");
    expect(heard).toEqual([{ action: "save" }]);
  });

  it("marks the languages saved and hands the change over, once, after the host's save", async () => {
    const save = vi.fn<(context: BuilderSaveContext) => void>();
    const element = await mount({ save }, LANGUAGES);
    const heard = fileActionEvents();
    const markLocalesSaved = vi.spyOn(element.controller, "markLocalesSaved");
    expect(element.controller.renameLocale("fr", "fr-CA")).toBe(true);
    const changes = { removed: [], renamed: [{ from: "fr", to: "fr-CA" }] };
    q(element, "[data-file-save]").click();
    expect(save.mock.calls[0]![0]).toEqual({ localeChanges: changes });
    expect(markLocalesSaved).toHaveBeenCalledTimes(1);
    expect(element.controller.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    expect(heard).toEqual([{ action: "save", localeChanges: changes }]);
  });

  it("hands the next save a language renamed while a save was pending: the baseline is what the save was handed", async () => {
    const pending = deferred();
    const save = vi.fn<(context: BuilderSaveContext) => Promise<void>>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const element = await mount({ save }, LANGUAGES);
    const first = element.requestSave();
    expect(save.mock.calls[0]![0].localeChanges).toEqual({ removed: [], renamed: [] });
    // Nothing holds the Languages workspace while the save is pending.
    expect(element.controller.localizationActions.renameLocale("fr", "fr-CA")).toBe(true);
    pending.resolve();
    await expect(first).resolves.toEqual({ status: "saved" });
    const changes = { removed: [], renamed: [{ from: "fr", to: "fr-CA" }] };
    expect(element.localeChangesSinceSave()).toEqual(changes);
    await expect(element.requestSave()).resolves.toEqual({ status: "saved", localeChanges: changes });
    expect(save.mock.calls[1]![0].localeChanges).toEqual(changes);
  });

  it("hands the next save both what a failed save was handed and what moved while it was pending", async () => {
    const pending = deferred();
    const save = vi.fn<(context: BuilderSaveContext) => Promise<void>>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const element = await mount({ save }, LANGUAGES);
    expect(element.controller.renameLocale("fr", "fr-CA")).toBe(true);
    const first = element.requestSave();
    expect(save.mock.calls[0]![0].localeChanges).toEqual({ removed: [], renamed: [{ from: "fr", to: "fr-CA" }] });
    expect(element.controller.renameLocale("fr-CA", "fr-QC")).toBe(true);
    pending.reject(new Error("Conflict 409"));
    await expect(first).resolves.toEqual({ status: "failed", message: "Conflict 409" });
    const changes = { removed: [], renamed: [{ from: "fr", to: "fr-QC" }] };
    expect(element.localeChangesSinceSave()).toEqual(changes);
    await expect(element.requestSave()).resolves.toEqual({ status: "saved", localeChanges: changes });
  });

  it("disables the Save item it makes busy even while it has the person's focus (Ctrl/Cmd+S in the open File menu)", async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const element = await mount({ save });
    const item = q<HTMLButtonElement>(element, "[data-file-save]");
    // The person opened the File menu; its first item, Save, has their focus, and the key comes from there.
    q(element, "[data-file-menu]").click();
    expect(element.shadowRoot!.activeElement).toBe(item);
    const key = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, composed: true, cancelable: true });
    item.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    // Their own Save as before: disabled, never the assistant's aria-disabled.
    expect(item.hasAttribute("aria-busy")).toBe(true);
    expect(item.disabled).toBe(true);
    expect(item.hasAttribute("aria-disabled")).toBe(false);
    pending.resolve();
    await flush();
    expect(item.disabled).toBe(false);
    expect(item.hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows the host's failure beside the File menu, for a throw and for a rejection, tells the host nothing and keeps the languages unsaved", async () => {
    const element = await mount(
      {
        save: () => {
          throw new Error("Disk full");
        }
      },
      LANGUAGES
    );
    const heard = fileActionEvents();
    expect(element.controller.renameLocale("fr", "fr-CA")).toBe(true);
    const changes = { removed: [], renamed: [{ from: "fr", to: "fr-CA" }] };
    q(element, "[data-file-save]").click();
    expect(q(element, "[data-file-error]").hidden).toBe(false);
    expect(q(element, "[data-file-error-message]").textContent).toContain("Disk full");
    element.fileActions = { save: () => Promise.reject(new Error("Conflict 409")) };
    q(element, "[data-file-save]").click();
    await flush();
    expect(q(element, "[data-file-error-message]").textContent).toContain("Conflict 409");
    expect(q<HTMLButtonElement>(element, "[data-file-save]").disabled).toBe(false);
    expect(element.controller.localeChangesSinceSave()).toEqual(changes);
    expect(heard).toEqual([]);
  });
});

describe("requestSave(): an assistant's Save", () => {
  it("answers no-save without a host Save, and asks nothing", async () => {
    const element = await mount({ download: () => ({ name: "form.json", text: "{}" }) });
    const requestLeave = vi.spyOn(element.activeController, "requestLeave");
    await expect(element.requestSave()).resolves.toEqual({ status: "no-save" });
    expect(element.saveAvailable()).toBeUndefined();
    expect(requestLeave).not.toHaveBeenCalled();
  });

  it("names the host's Save label in saveAvailable()", async () => {
    const element = await mount({ save: () => undefined });
    expect(element.saveAvailable()).toEqual({ label: "Save" });
    element.fileActions = { save: () => undefined, saveLabel: " Save draft " };
    expect(element.saveAvailable()).toEqual({ label: "Save draft" });
    element.fileActions = { save: () => undefined, saveLabel: "  " };
    expect(element.saveAvailable()).toEqual({ label: "Save" });
  });

  it("is held by a prompt already up, without raising another or answering it", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const controller = element.activeController;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Your name");
    // The person's own leave raised the prompt; the assistant's Save must leave it as it is.
    controller.requestLeave(() => undefined);
    const prompt = controller.unsavedChangesPrompt();
    expect(prompt).toMatchObject({ componentId: "fullName" });
    const requestLeave = vi.spyOn(controller, "requestLeave");
    const answer = vi.spyOn(controller, "answerUnsavedChangesPrompt");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "prompt", componentId: "fullName" });
    expect(controller.unsavedChangesPrompt()).toEqual(prompt);
    expect(requestLeave).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("is held by the selection's draft, then by the root's, never raising the prompt", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const controller = element.activeController;
    const requestLeave = vi.spyOn(controller, "requestLeave");
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Your name");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "fullName" });
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    controller.discardDraft("fullName");
    controller.setDraftProperty("root", "title", "Intake form");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "root" });
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(requestLeave).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // The drafts are still the person's.
    expect(controller.hasPendingChanges("root")).toBe(true);
  });

  it("names what requestLeave would ask about first: the selection's draft before the root's, a draft before a leave guard", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const controller = element.activeController;
    const requestLeave = vi.spyOn(controller, "requestLeave");
    // Both drafts open at once, the root's written first: the selection's is still named.
    controller.setDraftProperty("root", "title", "Intake form");
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Your name");
    expect(controller.hasPendingChanges("root")).toBe(true);
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "fullName" });
    // A draft and an editor outside the tree holding edits: the draft is named.
    controller.discardDraft("root");
    controller.setLeaveGuard({
      pending: () => true,
      subject: () => ({ id: "languages-texts", label: "Translations", blocked: false }),
      save: () => true,
      discard: () => undefined
    });
    expect(controller.hasPendingLeaveGuard()).toBe(true);
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "fullName" });
    // The root's draft before the guard too.
    controller.discardDraft("fullName");
    controller.setDraftProperty("root", "title", "Intake form");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "root" });
    // Only the guard left: it is named.
    controller.discardDraft("root");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "leave-guard", componentId: "languages-texts" });
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(requestLeave).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("is held by an editor outside the tree that holds edits, naming it", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const controller = element.activeController;
    const guardSave = vi.fn(() => true);
    const guardDiscard = vi.fn();
    controller.setLeaveGuard({
      pending: () => true,
      subject: () => ({ id: "languages-texts", label: "Translations", blocked: false }),
      save: guardSave,
      discard: guardDiscard
    });
    const requestLeave = vi.spyOn(controller, "requestLeave");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "leave-guard", componentId: "languages-texts" });
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(requestLeave).not.toHaveBeenCalled();
    expect(guardSave).not.toHaveBeenCalled();
    expect(guardDiscard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // A guard with nothing pending holds nothing back.
    controller.setLeaveGuard({ pending: () => false, subject: () => ({ id: "languages-texts", label: "Translations", blocked: false }), save: guardSave, discard: guardDiscard });
    await expect(element.requestSave()).resolves.toMatchObject({ status: "saved" });
  });

  it("says what holds it before saying busy: a draft opened while the person's save is pending", async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const element = await mount({ save });
    const controller = element.activeController;
    q(element, "[data-file-save]").click();
    expect(save).toHaveBeenCalledTimes(1);
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Your name");
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "fullName" });
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    controller.discardDraft("fullName");
    await expect(element.requestSave()).resolves.toEqual({ status: "busy" });
    pending.resolve();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("asks the controller on the page, as the person's Save does: a designer's draft or leave guard holds it while the form is clean", async () => {
    const save = vi.fn();
    const element = await mount({ save });
    const designer = await enterDesigner(element);
    const formLeave = vi.spyOn(element.controller, "requestLeave");
    const designerLeave = vi.spyOn(designer, "requestLeave");
    designer.select("layoutField");
    designer.setDraftProperty("layoutField", "label", "Renamed on the layout");
    expect(element.controller.hasPendingChanges(element.controller.rootId())).toBe(false);
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "draft", componentId: "layoutField" });
    designer.discardDraft("layoutField");
    designer.setLeaveGuard({
      pending: () => true,
      subject: () => ({ id: "pdf-mapping", label: "Mapping", blocked: false }),
      save: () => true,
      discard: () => undefined
    });
    expect(element.controller.hasPendingLeaveGuard()).toBe(false);
    await expect(element.requestSave()).resolves.toEqual({ status: "held", reason: "leave-guard", componentId: "pdf-mapping" });
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
    expect(formLeave).not.toHaveBeenCalled();
    expect(designerLeave).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the person's focus on the Save item it makes busy: aria-disabled, not disabled, and still one save", async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const element = await mount({ save });
    const item = q<HTMLButtonElement>(element, "[data-file-save]");
    // The person opened the File menu; the first item, Save, has their focus.
    q(element, "[data-file-menu]").click();
    expect(element.shadowRoot!.activeElement).toBe(item);
    const first = element.requestSave();
    expect(item.hasAttribute("aria-busy")).toBe(true);
    expect(item.disabled).toBe(false);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.querySelector(".file-item-label")!.textContent).toBe("Saving…");
    expect(element.shadowRoot!.activeElement).toBe(item);
    // Still one save at a time, by the key and by the item itself.
    pressSave(element);
    item.click();
    expect(save).toHaveBeenCalledTimes(1);
    pending.resolve();
    await expect(first).resolves.toEqual({ status: "saved" });
    expect(item.hasAttribute("aria-disabled")).toBe(false);
    expect(item.disabled).toBe(false);
    // With the person's focus elsewhere the item is disabled as for their own Save.
    const second = deferred();
    element.fileActions = { save: () => second.promise };
    (document.activeElement as HTMLElement | null)?.blur();
    expect(element.shadowRoot!.activeElement).not.toBe(item);
    const again = element.requestSave();
    expect(item.disabled).toBe(true);
    expect(item.hasAttribute("aria-disabled")).toBe(false);
    second.resolve();
    await expect(again).resolves.toEqual({ status: "saved" });
  });

  it("leaves an old message up while the person's focus is on its Dismiss, and puts it away otherwise", async () => {
    const element = await mount({ save: () => Promise.reject(new Error("Conflict 409")) });
    await expect(element.requestSave()).resolves.toMatchObject({ status: "failed" });
    const box = q(element, "[data-file-error]");
    const dismiss = q<HTMLButtonElement>(element, "[data-file-error-dismiss]");
    expect(box.hidden).toBe(false);
    dismiss.focus();
    expect(element.shadowRoot!.activeElement).toBe(dismiss);
    const heard = fileActionEvents();
    element.fileActions = { save: () => Promise.resolve() };
    await expect(element.requestSave()).resolves.toEqual({ status: "saved" });
    expect(heard).toEqual([{ action: "save", trigger: "agent" }]);
    expect(box.hidden).toBe(false);
    expect(element.shadowRoot!.activeElement).toBe(dismiss);
    // The person's own Save puts it away wherever their focus is (unchanged).
    pressSave(element);
    await flush();
    expect(heard).toEqual([{ action: "save", trigger: "agent" }, { action: "save" }]);
    expect(box.hidden).toBe(true);
    // Focus elsewhere: the assistant's next save puts a message away as the person's does.
    element.fileActions = { save: () => Promise.reject(new Error("Conflict 409")) };
    await expect(element.requestSave()).resolves.toMatchObject({ status: "failed" });
    expect(box.hidden).toBe(false);
    dismiss.blur();
    expect(element.shadowRoot!.activeElement).toBeNull();
    element.fileActions = { save: () => Promise.resolve() };
    await expect(element.requestSave()).resolves.toEqual({ status: "saved" });
    expect(box.hidden).toBe(true);
  });

  it("answers busy while a save runs, the person's or its own, and shares the Saving… latch", async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const element = await mount({ save });
    const item = q<HTMLButtonElement>(element, "[data-file-save]");
    const first = element.requestSave();
    expect(item.hasAttribute("aria-busy")).toBe(true);
    expect(item.querySelector(".file-item-label")!.textContent).toBe("Saving…");
    await expect(element.requestSave()).resolves.toEqual({ status: "busy" });
    // The person's Save (Ctrl/Cmd+S, past the busy item) while the assistant's runs starts nothing either.
    expect(pressSave(element).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    pending.resolve();
    await expect(first).resolves.toEqual({ status: "saved" });
    expect(item.hasAttribute("aria-busy")).toBe(false);
    // And the other way round: the person's pending save makes the assistant's busy.
    const second = deferred();
    element.fileActions = { save: () => second.promise };
    item.click();
    await expect(element.requestSave()).resolves.toEqual({ status: "busy" });
    second.resolve();
    await flush();
  });

  it("answers failed with the host's words on a rejection and on a throw, shown beside the File menu as for the person", async () => {
    const element = await mount({ save: () => Promise.reject(new Error("This form was changed elsewhere.")) });
    const heard = fileActionEvents();
    await expect(element.requestSave()).resolves.toEqual({ status: "failed", message: "This form was changed elsewhere." });
    expect(q(element, "[data-file-error-message]").textContent).toContain("This form was changed elsewhere.");
    expect(q<HTMLButtonElement>(element, "[data-file-save]").disabled).toBe(false);
    element.fileActions = {
      save: () => {
        throw new Error("No connection");
      }
    };
    await expect(element.requestSave()).resolves.toEqual({ status: "failed", message: "No connection" });
    expect(heard).toEqual([]);
  });

  it("saves with trigger 'agent' in the host's context and the event, once, handing the languages changed", async () => {
    const save = vi.fn<(context: BuilderSaveContext) => Promise<void>>(() => Promise.resolve());
    const element = await mount({ save }, LANGUAGES);
    const heard = fileActionEvents();
    const requestLeave = vi.spyOn(element.activeController, "requestLeave");
    const markLocalesSaved = vi.spyOn(element.controller, "markLocalesSaved");
    expect(element.controller.renameLocale("fr", "fr-CA")).toBe(true);
    const changes = { removed: [], renamed: [{ from: "fr", to: "fr-CA" }] };
    await expect(element.requestSave()).resolves.toEqual({ status: "saved", localeChanges: changes });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toEqual({ localeChanges: changes, trigger: "agent" });
    expect(heard).toEqual([{ action: "save", localeChanges: changes, trigger: "agent" }]);
    expect(markLocalesSaved).toHaveBeenCalledTimes(1);
    expect(requestLeave).not.toHaveBeenCalled();
    expect(element.activeController.unsavedChangesPrompt()).toBeUndefined();
    // Nothing changed since: the answer and the event carry no languages.
    await expect(element.requestSave()).resolves.toEqual({ status: "saved" });
    expect(heard[1]).toEqual({ action: "save", trigger: "agent" });
  });

  it("saves through a host save that answers at once (no promise)", async () => {
    const save = vi.fn<(context: BuilderSaveContext) => void>();
    const element = await mount({ save });
    const heard = fileActionEvents();
    await expect(element.requestSave()).resolves.toEqual({ status: "saved" });
    expect(save.mock.calls[0]![0]).toEqual({ localeChanges: { removed: [], renamed: [] }, trigger: "agent" });
    expect(heard).toEqual([{ action: "save", trigger: "agent" }]);
    expect(q<HTMLButtonElement>(element, "[data-file-save]").hasAttribute("aria-busy")).toBe(false);
  });
});
