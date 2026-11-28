import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, PdfGeneratedLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/*
 * The element's own file actions meet the unsaved-edits guard and the Form panel: Open waits for
 * a pending draft as New and Download do, the default Download carries the edit Save just landed,
 * New asks about PDF layouts the PDF designer is off for, and the Form panel's id and version
 * boxes commit through the panel's own Save.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
});

const EMPTY_ROOT = { id: "root", type: "form", configuration: {}, children: { content: [] } };

function designedLayout(): PdfGeneratedLayout {
  return {
    id: "letter",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
    }
  };
}

/** Another form altogether, to be opened over the sample. */
function loadedForm(): FormDefinition {
  return {
    id: "loaded-form",
    version: "2.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Loaded form" },
      children: { content: [{ id: "loaded_name", type: "text", configuration: { label: "Loaded name" } }] }
    }
  };
}

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

function q<T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T {
  return shell(element).querySelector<T>(selector)!;
}

const confirmOpen = (element: DatumFormBuilderElement): boolean => q(element, "[data-file-confirm]").hasAttribute("open");

/** Chooses a file in the shell's hidden picker, as the browser would: files set, then a change. */
function chooseFile(element: DatumFormBuilderElement, file: File): void {
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

/** Stubs what a download needs (jsdom has no object URLs) and records each file saved; the no-op revoke stays for the late call. */
function captureDownloads(): Array<{ name: string; blob: Blob }> {
  const saved: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", {
    value: (blob: Blob) => {
      const url = `blob:ported-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    configurable: true,
    writable: true
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: blobs.get(this.href)! });
  });
  return saved;
}

/** Makes a draft the author has typed but not applied, on the sample's first field. */
function draftALabel(element: DatumFormBuilderElement, label: string): void {
  const controller = element.controller!;
  controller.select("fullName");
  controller.setDraftProperty("fullName", "label", label);
  expect(controller.hasPendingChanges("fullName")).toBe(true);
}

describe("<datum-form-builder> Open behind the unsaved-edits guard", () => {
  it("holds a chosen file while a draft is pending: Keep editing leaves the form alone, Discard goes on to the question and loads it", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = await mount((el) => {
      el.definition = sampleDefinition();
    });
    draftALabel(element, "Legal name");
    const file = (): File => new File([JSON.stringify(loadedForm())], "loaded.json", { type: "application/json" });

    chooseFile(element, file());
    await until(() => element.controller!.unsavedChangesPrompt());
    // The guard first: the builder's own question waits for it, and nothing has been replaced.
    expect(element.controller!.unsavedChangesPrompt()).toMatchObject({ componentId: "fullName", action: "leave" });
    expect(confirmOpen(element)).toBe(false);
    expect(element.definition.id).toBe("sample-form");

    // Keep editing: nothing loads, nothing is asked, the draft is still there.
    element.controller!.answerUnsavedChangesPrompt("stay");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(element.controller!.unsavedChangesPrompt()).toBeUndefined();
    expect(confirmOpen(element)).toBe(false);
    expect(element.definition.id).toBe("sample-form");
    expect(element.controller!.hasPendingChanges("fullName")).toBe(true);
    expect(element.controller!.draftProperty("fullName", "label")).toBe("Legal name");

    // Discard, then yes to the replacement: the file takes the form's place.
    chooseFile(element, file());
    await until(() => element.controller!.unsavedChangesPrompt());
    element.controller!.answerUnsavedChangesPrompt("discard");
    await until(() => confirmOpen(element));
    expect(element.definition.id).toBe("sample-form");
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(element.definition.id).toBe("loaded-form");
    expect(element.definition.root.children?.content?.map((child) => child.id)).toEqual(["loaded_name"]);
  });
});

describe("<datum-form-builder> Download behind the unsaved-edits guard", () => {
  it("holds the default Download for a pending draft, and the file that follows Save carries the edit", async () => {
    const saved = captureDownloads();
    const element = await mount((el) => {
      el.definition = sampleDefinition();
    });
    draftALabel(element, "Legal name");

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    // Held: no file yet, and the prompt says why.
    expect(saved).toHaveLength(0);
    expect(element.controller!.unsavedChangesPrompt()?.action).toBe("leave");

    // Save: the edit lands, and the file that follows holds it.
    element.controller!.answerUnsavedChangesPrompt("save");
    expect(saved).toHaveLength(1);
    const written = JSON.parse(await readBlob(saved[0]!.blob)) as FormDefinition;
    expect(written.root.children?.content?.[0]?.configuration).toMatchObject({ label: "Legal name" });
    expect(element.definition.root.children?.content?.[0]?.configuration).toMatchObject({ label: "Legal name" });
  });
});

describe("<datum-form-builder> New with the PDF designer off", () => {
  it("asks while the form holds a PDF layout, and starts a form with none; a second New asks nothing", async () => {
    const element = await mount((el) => {
      el.setAttribute("features", "-pdf");
      el.definition = { id: "setup", version: "1.0.0", schemaVersion: "1", root: EMPTY_ROOT, pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } } as FormDefinition;
    });
    // An empty tree, but the layouts are someone's work, designer or no designer.
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);
    expect(element.fileActions.isEmpty?.()).toBe(false);

    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(confirmOpen(element)).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-confirm-cancel]").click();
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);

    q<HTMLButtonElement>(element, "[data-file-new]").click();
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(element.definition.pdf).toBeUndefined();
    expect(element.definition.root.children?.content?.map((child) => child.id)).toEqual(["submit"]);

    // Nothing left to lose: the form New started is the untouched seed.
    expect(element.fileActions.isEmpty?.()).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(confirmOpen(element)).toBe(false);
  });
});

describe("<datum-form-builder> identity on the Form panel", () => {
  function formPanelRoot(element: DatumFormBuilderElement): ShadowRoot {
    const panel = q(element, "datum-builder-form-panel");
    if (panel.hidden) {
      q<HTMLButtonElement>(element, '[data-strip] [data-panel="form"]').click();
    }
    return panel.shadowRoot!;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("takes the id and version typed into their boxes only on the panel's Save, and the file that follows carries them", async () => {
    const saved = captureDownloads();
    const element = await mount((el) => {
      el.definition = sampleDefinition();
    });
    const root = formPanelRoot(element);
    await until(() => root.querySelector('input[data-identity-field="id"]'));
    const box = (field: "id" | "version" | "schemaVersion"): HTMLInputElement => root.querySelector<HTMLInputElement>(`input[data-identity-field="${field}"]`)!;
    expect(box("id").value).toBe("sample-form");
    expect(box("version").value).toBe("2.0.0");
    expect(box("schemaVersion").value).toBe("1");

    type(box("id"), "customer-intake");
    type(box("version"), "2.1.0");
    // Drafted, not committed: the host still sees the old identity until Save.
    expect(element.definition).toMatchObject({ id: "sample-form", version: "2.0.0", schemaVersion: "1" });
    expect(box("id").value).toBe("customer-intake");

    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(element.definition).toMatchObject({ id: "customer-intake", version: "2.1.0", schemaVersion: "1" });

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(await readBlob(saved[0]!.blob))).toMatchObject({ id: "customer-intake", version: "2.1.0", schemaVersion: "1" });
  });

  it("keeps the current value of a box left blank rather than emptying the field", async () => {
    const element = await mount((el) => {
      el.definition = sampleDefinition();
    });
    const root = formPanelRoot(element);
    await until(() => root.querySelector('input[data-identity-field="id"]'));
    const box = (field: "id" | "version"): HTMLInputElement => root.querySelector<HTMLInputElement>(`input[data-identity-field="${field}"]`)!;
    type(box("version"), "   ");
    type(box("id"), "intake");
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(element.definition).toMatchObject({ id: "intake", version: "2.0.0", schemaVersion: "1" });
    expect(box("version").value).toBe("2.0.0");
  });
});
