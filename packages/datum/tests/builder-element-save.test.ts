import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement, DatumFormBuilderFileActionDetail, DatumFormBuilderSaveDetail } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The element's own Save: the `save` attribute puts Save in the ⋮ menu; bare, it
 * leaves the storing to a `datum-builder-save` listener, and with an address it has the element
 * send the form there itself; `save-method` and `save-label` shape it; a `fileActions.save`
 * function wins over all of it.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

async function mount(attributes: Record<string, string> = {}): Promise<{ element: DatumFormBuilderElement; errors: string[] }> {
  const element = document.createElement("datum-form-builder");
  const errors: string[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return { element, errors };
}

function q<T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T {
  return element.builder!.shadowRoot!.querySelector<T>(selector)!;
}

const saveItem = (element: DatumFormBuilderElement): HTMLButtonElement => q<HTMLButtonElement>(element, "[data-file-save]");
const saveLabel = (element: DatumFormBuilderElement): string => saveItem(element).querySelector(".file-item-label")?.textContent ?? "";
const fileError = (element: DatumFormBuilderElement): string => q(element, "[data-file-error-message]").textContent ?? "";

/** An edit that is in the form, so the definition differs from the saved one. */
function edit(element: DatumFormBuilderElement, label = "Changed"): void {
  const controller = element.builder!.controller;
  controller.select("fullName");
  controller.setDraftProperty("fullName", "label", label);
  controller.commitDraft("fullName");
}

/** The save events the page hears, each kept whole. */
function saveEvents(element: DatumFormBuilderElement, each?: (event: CustomEvent<DatumFormBuilderSaveDetail>) => void): DatumFormBuilderSaveDetail[] {
  const heard: DatumFormBuilderSaveDetail[] = [];
  element.addEventListener("datum-builder-save", (event) => {
    heard.push((event as CustomEvent<DatumFormBuilderSaveDetail>).detail);
    each?.(event as CustomEvent<DatumFormBuilderSaveDetail>);
  });
  return heard;
}

function completedActions(element: DatumFormBuilderElement): string[] {
  const done: string[] = [];
  element.addEventListener("datum-builder-file-action", (event) => done.push((event as CustomEvent<DatumFormBuilderFileActionDetail>).detail.action));
  return done;
}

/** A `fetch` that answers every request with `answer` and records what it was asked. */
function stubFetch(answer: () => Response | Promise<Response>): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return answer();
    })
  );
  return calls;
}

const ok = (): Response => new Response(null, { status: 204 });

describe("<datum-form-builder> save attribute", () => {
  it("has no Save until the page asks for one, and names it by save-label", async () => {
    const { element } = await mount();
    expect(saveItem(element).hidden).toBe(true);
    expect(element.fileActions.save).toBeUndefined();

    element.setAttribute("save", "");
    expect(element.save).toBe(true);
    expect(saveItem(element).hidden).toBe(false);
    expect(saveLabel(element)).toBe("Save");
    // Ruled off from New, Open and Download, which stay.
    expect(q(element, "[data-file-save-sep]").hidden).toBe(false);
    expect(q(element, "[data-file-new]").hidden).toBe(false);

    element.setAttribute("save-label", "Save draft");
    expect(saveLabel(element)).toBe("Save draft");
    expect(element.saveLabel).toBe("Save draft");
    element.removeAttribute("save-label");
    expect(saveLabel(element)).toBe("Save");

    // Save is not one of the file actions file-actions names: it stays when they are put away.
    element.setAttribute("file-actions", "off");
    expect(saveItem(element).hidden).toBe(false);
    expect(q(element, "[data-file-new]").hidden).toBe(true);

    element.removeAttribute("save");
    expect(saveItem(element).hidden).toBe(true);
  });

  it("takes the property as the attribute: true is a bare save, a string an address, false none", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount();
    expect(element.save).toBe(false);

    element.save = true;
    expect(saveItem(element).hidden).toBe(false);
    expect(element.save).toBe(true);

    element.save = "  /api/forms/intake ";
    expect(element.save).toBe("/api/forms/intake");
    edit(element);
    saveItem(element).click();
    await until(() => calls.length === 1);
    expect(calls[0]!.url).toBe("/api/forms/intake");

    // An empty string is the bare attribute: a Save that sends nothing.
    element.save = "";
    expect(element.save).toBe(true);
    element.save = false;
    expect(element.save).toBe(false);
    expect(saveItem(element).hidden).toBe(true);
  });

  it("no longer reads a save-url attribute: the attribute is gone, not renamed", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount({ "save-url": "/api/forms/intake" });
    expect(element.save).toBe(false);
    expect(saveItem(element).hidden).toBe(true);
    expect(calls).toEqual([]);
  });

  it("hands the form to a datum-builder-save listener, waits for its work, and counts the form saved", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount({ save: "" });
    const done = completedActions(element);
    let stored!: () => void;
    const heard = saveEvents(element, (event) => event.detail.waitUntil(new Promise<void>((resolve) => (stored = resolve))));
    edit(element);
    expect(element.dirty).toBe(true);

    saveItem(element).click();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.definition).toEqual(element.definition);
    expect(heard[0]!.localeChanges).toEqual({ removed: [], renamed: [] });
    expect(heard[0]!.trigger).toBeUndefined();
    // Pending: the item says so, and the form is not saved yet.
    await until(() => saveLabel(element) === "Saving…");
    expect(saveItem(element).disabled).toBe(true);
    expect(element.dirty).toBe(true);
    expect(done).toEqual([]);

    stored();
    await until(() => !element.dirty);
    expect(saveLabel(element)).toBe("Save");
    expect(element.savedDefinition).toEqual(heard[0]!.definition);
    expect(done).toEqual(["save"]);
    // The storing was the page's: the element asked nothing of the network.
    expect(calls).toEqual([]);
  });

  it("fails the save with what a listener's work rejected with, and leaves the form unsaved", async () => {
    const { element } = await mount({ save: "" });
    const done = completedActions(element);
    saveEvents(element, (event) => event.detail.waitUntil(Promise.reject(new Error("the catalog is locked"))));
    edit(element);

    saveItem(element).click();
    await until(() => fileError(element) !== "");
    expect(fileError(element)).toBe("Could not save: the catalog is locked.");
    expect(element.dirty).toBe(true);
    expect(done).toEqual([]);
  });

  it("refuses a waitUntil called once the event is over", async () => {
    const { element } = await mount({ save: "" });
    const heard = saveEvents(element);
    saveItem(element).click();
    await until(() => heard.length === 1);
    expect(() => heard[0]!.waitUntil(Promise.resolve())).toThrow("waitUntil() must be called while datum-builder-save is being dispatched");
  });

  it("keeps an edit made while the save ran as unsaved", async () => {
    const { element } = await mount({ save: "" });
    let stored!: () => void;
    const heard = saveEvents(element, (event) => event.detail.waitUntil(new Promise<void>((resolve) => (stored = resolve))));
    edit(element);
    saveItem(element).click();
    await until(() => saveLabel(element) === "Saving…");
    edit(element, "Changed again");
    stored();
    await until(() => saveLabel(element) === "Save");
    expect(element.savedDefinition).toEqual(heard[0]!.definition);
    expect(element.dirty).toBe(true);
  });
});

describe("<datum-form-builder> save attribute with an address", () => {
  it("sends the form as JSON by PUT and counts it saved on a 2xx answer", async () => {
    const calls = stubFetch(ok);
    const { element, errors } = await mount({ save: "/api/forms/intake" });
    const done = completedActions(element);
    const heard = saveEvents(element);
    expect(errors).toEqual([]);
    expect(element.save).toBe("/api/forms/intake");
    expect(saveItem(element).hidden).toBe(false);
    edit(element);
    const sent = element.definition;

    saveItem(element).click();
    await until(() => !element.dirty);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/forms/intake");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(sent);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    // The page still hears the save, before the request, and that it completed, after.
    expect(heard.map((detail) => detail.definition)).toEqual([sent]);
    expect(done).toEqual(["save"]);
    expect(element.savedDefinition).toEqual(sent);
    expect(fileError(element)).toBe("");
  });

  it("sends by POST when save-method says so, and reports a method it does not send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = stubFetch(ok);
    const { element, errors } = await mount({ save: "/api/forms", "save-method": "post" });
    expect(element.saveMethod).toBe("POST");
    edit(element);
    saveItem(element).click();
    await until(() => calls.length === 1);
    expect(calls[0]!.init.method).toBe("POST");

    element.setAttribute("save-method", "DELETE");
    expect(errors).toEqual(['save-method must be PUT or POST, not "DELETE"']);
    expect(element.saveMethod).toBe("POST");
    element.removeAttribute("save-method");
    expect(element.saveMethod).toBe("PUT");
  });

  it("shows the server's refusal beside the menu and leaves the form unsaved", async () => {
    stubFetch(() => new Response("no", { status: 409, statusText: "Conflict" }));
    const { element } = await mount({ save: "/api/forms/intake" });
    const done = completedActions(element);
    edit(element);

    saveItem(element).click();
    await until(() => fileError(element) !== "");
    expect(fileError(element)).toBe("Could not save: the server answered 409 Conflict.");
    expect(element.dirty).toBe(true);
    expect(done).toEqual([]);
    expect(saveLabel(element)).toBe("Save");
  });

  it("says so when the server cannot be reached, or takes too long", async () => {
    let failure: Error = new TypeError("Failed to fetch");
    stubFetch(() => Promise.reject(failure));
    const { element } = await mount({ save: "/api/forms/intake" });
    edit(element);

    saveItem(element).click();
    await until(() => fileError(element) !== "");
    expect(fileError(element)).toBe("Could not save: the server could not be reached.");

    failure = new DOMException("The operation timed out", "TimeoutError");
    saveItem(element).click();
    await until(() => fileError(element).includes("too long"));
    expect(fileError(element)).toBe("Could not save: the server took too long to answer.");
    expect(element.dirty).toBe(true);
  });

  it("waits for a listener's work before its own request, and makes none when the event is cancelled", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount({ save: "/api/forms/intake" });
    let first!: () => void;
    let cancel = false;
    saveEvents(element, (event) => {
      if (cancel) {
        event.preventDefault();
      } else {
        event.detail.waitUntil(new Promise<void>((resolve) => (first = resolve)));
      }
    });
    edit(element);

    saveItem(element).click();
    await until(() => saveLabel(element) === "Saving…");
    expect(calls).toEqual([]);
    first();
    await until(() => calls.length === 1);
    await until(() => !element.dirty);

    // Cancelled: the page stored the form itself, so it counts as saved with no request.
    cancel = true;
    edit(element, "Changed again");
    expect(element.dirty).toBe(true);
    saveItem(element).click();
    await until(() => !element.dirty);
    expect(calls).toHaveLength(1);
  });

  it("is held to the page's origin unless allow-origins lists another; the property may name any", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element, errors } = await mount({ save: "https://elsewhere.example/forms/intake" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("The save attribute was not used: it names https://elsewhere.example");
    expect(errors[0]).toContain("the save property may name any");
    expect(element.save).toBe(false);
    expect(saveItem(element).hidden).toBe(true);

    element.setAttribute("allow-origins", "https://elsewhere.example");
    expect(element.save).toBe("https://elsewhere.example/forms/intake");
    expect(saveItem(element).hidden).toBe(false);

    element.removeAttribute("allow-origins");
    expect(element.save).toBe(false);
    element.save = "https://other.example/forms";
    expect(saveItem(element).hidden).toBe(false);
  });
});

describe("<datum-form-builder> Save beside the page's own", () => {
  it("lets a fileActions.save function win over the attributes", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount({ save: "/api/forms/intake", "save-label": "Save draft" });
    const heard = saveEvents(element);
    const own = vi.fn();
    element.fileActions = { save: own };
    // save-label still names the item, until the page names it too.
    expect(saveLabel(element)).toBe("Save draft");
    element.fileActions = { save: own, saveLabel: "Publish" };
    expect(saveLabel(element)).toBe("Publish");

    saveItem(element).click();
    expect(own).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
    expect(calls).toEqual([]);

    // Taken back, the attributes' Save returns.
    element.fileActions = undefined;
    saveItem(element).click();
    await until(() => calls.length === 1);
    expect(heard).toHaveLength(1);
  });

  it("leaves the form unsaved after a Download: with a Save, a Download is an export", async () => {
    (URL as unknown as Record<string, unknown>).createObjectURL = () => "blob:form";
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { element } = await mount({ save: "" });
    edit(element);
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(element.dirty).toBe(true);
  });

  it("saves on Ctrl/Cmd+S inside the builder", async () => {
    const calls = stubFetch(ok);
    const { element } = await mount({ save: "/api/forms/intake" });
    edit(element);
    q(element, "datum-builder-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
    await until(() => calls.length === 1);
    await until(() => !element.dirty);
  });
});
