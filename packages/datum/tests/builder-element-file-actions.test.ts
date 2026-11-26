import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import "../src/builder.js";
import type {
  DatumFormBuilderChangeDetail,
  DatumFormBuilderElement,
  DatumFormBuilderFileActionDetail
} from "../src/builder.js";
import type { FormDefinition, JourneyConfiguration, PdfGeneratedLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
});

const EMPTY_ROOT = { id: "root", type: "form", configuration: {}, children: { content: [] } };

/** What File > New starts the form with: one Submit button at the end of the empty tree. */
const NEW_FORM_ROOT = {
  ...EMPTY_ROOT,
  children: { content: [{ id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } }] }
};

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

function journeyBlock(): JourneyConfiguration {
  return { journeys: [{ id: "solo", pages: [{ id: "one", components: ["fullName"] }] }] };
}

/** The sample form with everything a whole definition carries: languages, PDF layouts and journeys. */
function fullDefinition(): FormDefinition {
  return { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" }, journey: journeyBlock() };
}

function mount(setup?: (element: DatumFormBuilderElement) => void, parent: ParentNode = document.body): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  setup?.(element);
  parent.append(element);
  return element;
}

/** Waits for the inner builder to have mounted its panels. */
async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

function q<T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T {
  return shell(element).querySelector<T>(selector)!;
}

/** The file menu's items on show, by their text (which names them), in the order the menu draws them. */
function shownFileItems(element: DatumFormBuilderElement): string[] {
  const group = q(element, "[data-file-actions]");
  if (group.hidden) {
    return [];
  }
  // The file items alone: Dark mode shares the menu but is the shell's own.
  return [...group.querySelectorAll<HTMLButtonElement>("[data-file-menu-list] [role=menuitem]:not([hidden]):not([data-file-scheme])")].map(
    (item) => item.querySelector(".file-item-label")?.textContent ?? ""
  );
}

function confirmOpen(element: DatumFormBuilderElement): boolean {
  return q(element, "[data-file-confirm]").hasAttribute("open");
}

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

/** Stubs what a download needs (jsdom has no object URLs) and records each file saved. */
function captureDownloads(): Array<{ name: string; type: string; blob: Blob }> {
  const saved: Array<{ name: string; type: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", {
    value: (blob: Blob) => {
      const url = `blob:file-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    configurable: true,
    writable: true
  });
  // Revoked a moment later: the no-op stays in place after the test, for that late call.
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href)!;
    saved.push({ name: this.download, type: blob.type, blob });
  });
  return saved;
}

/** The wrapper's events in the order they arrive: its changes (with the definition then), and the file actions. */
function record(element: DatumFormBuilderElement): Array<{ event: string; detail: unknown }> {
  const heard: Array<{ event: string; detail: unknown }> = [];
  element.addEventListener("datum-builder-change", (event) =>
    heard.push({ event: "change", detail: (event as CustomEvent<DatumFormBuilderChangeDetail>).detail })
  );
  element.addEventListener("datum-builder-file-action", (event) =>
    heard.push({ event: "file-action", detail: (event as CustomEvent<DatumFormBuilderFileActionDetail>).detail })
  );
  return heard;
}

/** The PDF layout ids and the journeys a heard event's definition carries. */
function sides(detail: unknown): { layouts: string[] | undefined; journey: unknown } {
  const definition = (detail as { definition: FormDefinition }).definition;
  return { layouts: definition.pdf?.layouts?.map((layout) => layout.id), journey: definition.journey };
}

describe("<datum-form-builder> file actions", () => {
  it("ends the bar with a File menu of its own New, Open and Download by default", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);
    // No Save: the element has nowhere to keep a form, and the page gave none.
    expect(q(element, "[data-file-save]").hidden).toBe(true);
    // The menu is last on the bar, so nothing of it leads undo/redo: no divider there.
    const group = q(element, "[data-file-actions]");
    expect(group.parentElement!.matches(".bar-end")).toBe(true);
    expect(group.parentElement!.lastElementChild).toBe(group);
    expect(q(element, "[data-host-sep]").hidden).toBe(true);
    const actions = element.fileActions;
    // With New comes the check that a New loses nothing.
    expect(Object.keys(actions)).toEqual(["new", "open", "download", "isEmpty"]);
    expect(Object.values(actions).every((action) => typeof action === "function")).toBe(true);
    // What the inner builder draws its buttons for.
    expect(Object.keys(element.builder!.fileActions ?? {})).toEqual(["new", "open", "download", "isEmpty"]);
  });

  it("shows none for file-actions=\"off\" or \"none\", those a list names, and all three again for \"auto\" or no attribute", async () => {
    const element = mount((el) => {
      el.setAttribute("file-actions", "off");
    });
    await ready(element);
    expect(shownFileItems(element)).toEqual([]);
    expect(element.fileActions).toEqual({});
    // No file item, no rule above Dark mode (the menu stays for it), and no divider before undo/redo.
    expect(q(element, "[data-file-actions]").hidden).toBe(false);
    expect(q(element, "[data-file-scheme-sep]").hidden).toBe(true);
    expect(q(element, "[data-file-scheme]").hidden).toBe(false);
    expect(q(element, "[data-host-sep]").hidden).toBe(true);

    element.setAttribute("file-actions", "open, download");
    expect(shownFileItems(element)).toEqual(["Open form file…", "Download form"]);
    expect(Object.keys(element.fileActions)).toEqual(["open", "download"]);

    element.setAttribute("file-actions", "download new");
    // The bar's order, whatever the list's.
    expect(shownFileItems(element)).toEqual(["New form", "Download form"]);

    element.setAttribute("file-actions", "none");
    expect(shownFileItems(element)).toEqual([]);

    element.setAttribute("file-actions", "auto");
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);

    element.setAttribute("file-actions", "open import");
    // A name it does not know is passed over.
    expect(shownFileItems(element)).toEqual(["Open form file…"]);

    element.setAttribute("file-actions", "");
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);

    element.setAttribute("file-actions", "new");
    element.removeAttribute("file-actions");
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);
  });

  it("takes the page's own actions over its own, null putting one away, and the attribute still filters them", async () => {
    const saved = captureDownloads();
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const own = element.fileActions;

    const download = vi.fn(() => ({ name: "mine.json", text: "{}\n", type: "application/json" }));
    element.fileActions = { download, open: null, new: undefined };
    expect(shownFileItems(element)).toEqual(["New form", "Download form"]);
    expect(element.fileActions.download).toBe(download);
    expect(element.fileActions.new).toBe(own.new);
    expect("open" in element.fileActions).toBe(false);

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(download).toHaveBeenCalledTimes(1);
    expect(saved.map((file) => file.name)).toEqual(["mine.json"]);

    // Set before connecting, it is handed over when the inner builder is built.
    const early = mount((el) => {
      el.fileActions = { new: null, download: null };
    });
    await ready(early);
    expect(shownFileItems(early)).toEqual(["Open form file…"]);

    // The attribute decides which show; the property what they do.
    element.setAttribute("file-actions", "download");
    expect(shownFileItems(element)).toEqual(["Download form"]);
    expect(Object.keys(element.fileActions)).toEqual(["download"]);
    expect(element.fileActions.download).toBe(download);
    element.setAttribute("file-actions", "open");
    // Put away by the property, and the only one the attribute allows: none.
    expect(shownFileItems(element)).toEqual([]);
    element.removeAttribute("file-actions");

    element.fileActions = undefined;
    expect(shownFileItems(element)).toEqual(["New form", "Open form file…", "Download form"]);
    expect(element.fileActions.download).toBe(own.download);
    expect(element.fileActions.open).toBe(own.open);
  });

  it("starts a new form under a fresh neutral id with a Submit button, keeping the version and nothing else of the old one", async () => {
    const element = mount((el) => {
      el.definition = fullDefinition();
    });
    await ready(element);
    // The identity as authored on the Form panel: its version and schema version carry over, its id does not.
    element.builder!.controller.setIdentity({ id: "customer-intake", version: "3.0.0", schemaVersion: "1" });
    const heard = record(element);

    q<HTMLButtonElement>(element, "[data-file-new]").click();
    // The form has components: the builder asks first.
    expect(confirmOpen(element)).toBe(true);
    expect(element.definition.root.children?.content).toHaveLength(5);
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();

    const definition = element.definition;
    expect(definition).toMatchObject({ version: "3.0.0", schemaVersion: "1" });
    expect(definition.id).toMatch(/^form-[0-9a-z]{6}$/);
    expect(definition.id).not.toBe("customer-intake");
    expect(definition.root).toEqual(NEW_FORM_ROOT);
    expect(definition.localization).toBeUndefined();
    expect(definition.journey).toBeUndefined();
    // The PDF side starts over on the empty form: the designed layout is gone, and none takes its place.
    expect(definition.pdf).toBeUndefined();
    expect(element.journeyConfiguration).toBeUndefined();
    // In place at once: the builder's "init" and the file action both carry the new form —
    // its tree, and the PDF layouts and journeys of the new form, not the old one's.
    expect(heard.map((entry) => entry.event)).toEqual(["change", "file-action"]);
    expect((heard[0]!.detail as DatumFormBuilderChangeDetail).reason).toBe("init");
    expect((heard[0]!.detail as DatumFormBuilderChangeDetail).definition.root).toEqual(NEW_FORM_ROOT);
    expect((heard[0]!.detail as DatumFormBuilderChangeDetail).definition.id).toBe(definition.id);
    // No layout is derived into the new form.
    expect(sides(heard[0]!.detail)).toEqual({ layouts: undefined, journey: undefined });
    expect(heard[1]!.detail).toMatchObject({ action: "new" });
    expect((heard[1]!.detail as DatumFormBuilderFileActionDetail).definition).toEqual(definition);
    // Nothing later puts it right: the two above are all there is.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toHaveLength(2);

    // With no PDF side, what is left is exactly the identity and an empty tree.
    const plain = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = { ...fullDefinition(), id: "plain", version: "4.0.0", schemaVersion: "2" };
    });
    await ready(plain);
    q<HTMLButtonElement>(plain, "[data-file-new]").click();
    q<HTMLButtonElement>(plain, "[data-file-confirm-ok]").click();
    expect(plain.definition).toEqual({ id: expect.stringMatching(/^form-[0-9a-z]{6}$/), version: "4.0.0", schemaVersion: "2", root: NEW_FORM_ROOT });
    // Every New is a form of its own: a second one under the same element gets another id.
    const firstId = plain.definition.id;
    q<HTMLButtonElement>(plain, "[data-file-new]").click();
    q<HTMLButtonElement>(plain, "[data-file-confirm-ok]").click();
    expect(plain.definition.id).not.toBe(firstId);
  });

  it("asks before New on a form with no components that still holds languages, a designed layout or journeys", async () => {
    const emptyTree = (): FormDefinition => ({ id: "setup", version: "1.0.0", schemaVersion: "1", root: { ...EMPTY_ROOT, children: { content: [] } } });
    const cases: Array<[string, FormDefinition]> = [
      ["languages", { ...emptyTree(), localization: sampleDefinition().localization! }],
      ["a designed layout", { ...emptyTree(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } }],
      ["journeys", { ...emptyTree(), journey: journeyBlock() }]
    ];
    for (const [what, definition] of cases) {
      const element = mount((el) => {
        el.definition = definition;
      });
      await ready(element);
      expect(element.fileActions.isEmpty?.(), what).toBe(false);
      q<HTMLButtonElement>(element, "[data-file-new]").click();
      expect(confirmOpen(element), what).toBe(true);
      q<HTMLButtonElement>(element, "[data-file-confirm-cancel]").click();
      expect(element.definition, what).toMatchObject(definition.localization ? { localization: definition.localization } : {});
      element.remove();
    }

    // Truly empty (the layout the PDF side derives is no one's work): New asks nothing. The form
    // it starts holds the seeded Submit button; untouched, that is not work to lose
    // either, so a New straight after a New asks nothing too.
    const empty = mount((el) => {
      el.definition = emptyTree();
    });
    await ready(empty);
    const heard = record(empty);
    expect(empty.fileActions.isEmpty?.()).toBe(true);
    q<HTMLButtonElement>(empty, "[data-file-new]").click();
    expect(confirmOpen(empty)).toBe(false);
    expect(heard.filter((entry) => entry.event === "file-action")).toHaveLength(1);
    expect(empty.definition.root.children?.content?.map((child) => child.id)).toEqual(["submit"]);
    expect(empty.fileActions.isEmpty?.()).toBe(true);
    const firstId = empty.definition.id;
    q<HTMLButtonElement>(empty, "[data-file-new]").click();
    expect(confirmOpen(empty)).toBe(false);
    expect(heard.filter((entry) => entry.event === "file-action")).toHaveLength(2);
    expect(empty.definition.id).not.toBe(firstId);

    // The seeded Submit touched (its label changed) or joined by a component is work: New asks.
    const controller = empty.builder!.controller;
    controller.select("submit");
    controller.setDraftProperty("submit", "label", "Send");
    expect(controller.commitDraft("submit")).toBe(true);
    expect(empty.fileActions.isEmpty?.()).toBe(false);
    q<HTMLButtonElement>(empty, "[data-file-new]").click();
    expect(confirmOpen(empty)).toBe(true);
    q<HTMLButtonElement>(empty, "[data-file-confirm-cancel]").click();

    // A page's own New keeps the element's check unless it hands in its own (or null).
    empty.fileActions = { new: vi.fn(), isEmpty: null };
    expect("isEmpty" in empty.fileActions).toBe(false);
    empty.fileActions = { new: vi.fn() };
    expect(typeof empty.fileActions.isEmpty).toBe("function");
  });

  it("opens a form file in place of the whole definition, PDF layouts and all", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const heard = record(element);
    const file: FormDefinition = {
      ...fullDefinition(),
      id: "imported",
      version: "7.0.0",
      localization: { defaultLocale: "fr-CA", supportedLocales: [{ code: "fr-CA", label: "Français (Canada)" }] },
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Imported" },
        children: { content: [{ id: "fullName", type: "text", configuration: { label: "Nom" } }] }
      }
    };

    q<HTMLButtonElement>(element, "[data-file-open]").click();
    chooseFile(element, new File([JSON.stringify(file)], "imported.json", { type: "application/json" }));
    await until(() => confirmOpen(element));
    expect(q(element, "[data-file-confirm-message]").textContent).toBe('Replace this form with "imported.json"? This can\'t be undone.');
    // Nothing replaced until the author says so.
    expect(element.definition.id).toBe("sample-form");
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();

    const definition = element.definition;
    expect(definition.id).toBe("imported");
    expect(definition.version).toBe("7.0.0");
    expect(definition.root).toEqual(file.root);
    expect(definition.localization).toEqual(file.localization);
    expect(definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);
    expect(definition.pdf?.defaultLayoutId).toBe("letter");
    expect(definition.journey).toEqual(journeyBlock());
    expect(element.pdfMode?.layouts.map((layout) => layout.id)).toEqual(["letter"]);
    expect(heard.map((entry) => entry.event)).toEqual(["change", "file-action"]);
    // The "init" change carries the file's layouts and journeys, not the old form's derived layout.
    expect((heard[0]!.detail as DatumFormBuilderChangeDetail).definition.id).toBe("imported");
    expect(sides(heard[0]!.detail)).toEqual({ layouts: ["letter"], journey: journeyBlock() });
    expect(heard[1]!.detail).toMatchObject({ action: "open", name: "imported.json" });
    expect((heard[1]!.detail as DatumFormBuilderFileActionDetail).definition).toEqual(definition);

    // A bare form tree is a form too, under the default identity.
    chooseFile(element, new File([JSON.stringify(file.root)], "tree.json"));
    await until(() => confirmOpen(element));
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(element.definition).toMatchObject({ id: "form", version: "1.0.0", schemaVersion: "1", root: file.root });
  });

  it("refuses a file that is not JSON, or not a form, with the reason on the bar", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const message = (): string => q(element, "[data-file-error-message]").textContent ?? "";
    const alert = q(element, "[data-file-error]");

    chooseFile(element, new File(["these are my notes"], "notes.txt"));
    await until(() => !alert.hidden);
    expect(message()).toMatch(/^Could not open "notes\.txt": it is not JSON: .+\.$/);
    expect(message()).toContain("JSON");

    chooseFile(element, new File(["[1, 2]"], "list.json"));
    await until(() => message().includes("list.json"));
    expect(message()).toBe('Could not open "list.json": A form definition must be an object with a `root` component tree.');

    chooseFile(element, new File(['{"id":"no-tree"}'], "no-tree.json"));
    await until(() => message().includes("no-tree.json"));
    expect(message()).toBe("Could not open \"no-tree.json\": A form definition's `root` must be a component node with `id` and `type`.");

    // Down the tree, the root being the form, and the shape of each block the builder takes:
    // each refused with where the problem is.
    const form = (extra: Record<string, unknown>, children: unknown = { content: [] }): string =>
      JSON.stringify({ id: "bad", root: { id: "root", type: "form", configuration: {}, children }, ...extra });
    const refusals: Array<[string, string, string]> = [
      ["child.json", form({}, { content: [42] }), "root.children.content[0] must be a component node object"],
      ["untyped.json", form({}, { content: [{ id: "a" }] }), "root.children.content[0].type must be a non-empty string"],
      ["junk.json", form({}, "junk"), "root.children must map slot ids to lists of component nodes"],
      ["text-root.json", JSON.stringify({ root: { id: "a", type: "text" } }), 'root must be the form (type "form"), not "text"'],
      ["journeys.json", form({ journey: { journeys: 3 } }), "journey.journeys must be a list of journeys"],
      ["layouts.json", form({ pdf: { layouts: "x" } }), "pdf.layouts must be a list of layouts"],
      ["locales.json", form({ localization: 5 }), "localization must be an object"]
    ];
    for (const [name, text, reason] of refusals) {
      chooseFile(element, new File([text], name));
      await until(() => message().includes(name));
      expect(message()).toBe(`Could not open "${name}": ${reason}.`);
    }
    // A malformed layout or journey inside a list is named by its place.
    chooseFile(element, new File([form({ pdf: { layouts: [{ id: "x" }] } })], "layout.json"));
    await until(() => message().includes("layout.json"));
    expect(message()).toMatch(/^Could not open "layout\.json": pdf\.layouts\[0\]: .+\.$/);
    chooseFile(element, new File([form({ journey: { journeys: [{ pages: 1 }] } })], "journey.json"));
    await until(() => message().includes("journey.json"));
    expect(message()).toMatch(/^Could not open "journey\.json": journey\.journeys\[0\]: .+\.$/);

    // Never asked, never replaced.
    expect(confirmOpen(element)).toBe(false);
    expect(element.definition.id).toBe("sample-form");
    expect(element.definition.root).toEqual(sampleDefinition().root);
    expect(element.definition.journey).toBeUndefined();
  });

  it("leaves the form as the author had it when the builder cannot take an accepted file", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    // An edit since the seed: it must survive the failed replacement.
    element.builder!.controller.setIdentity({ id: "sample-form-edited", version: "2.0.0", schemaVersion: "1" });
    const before = element.definition;
    // The builder refuses the file's tree once, as it would one it cannot build.
    const builder = element.builder!;
    const options = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(builder), "options")!;
    let refuse = true;
    Object.defineProperty(builder, "options", {
      configurable: true,
      get() {
        return options.get!.call(this);
      },
      set(value: { initialRoot?: { configuration?: Record<string, unknown> } }) {
        if (refuse && value.initialRoot?.configuration?.title === "Unbuildable") {
          refuse = false;
          throw new Error("the tree could not be built");
        }
        options.set!.call(this, value);
      }
    });

    const file = { id: "other", root: { id: "root", type: "form", configuration: { title: "Unbuildable" }, children: { content: [] } } };
    chooseFile(element, new File([JSON.stringify(file)], "other.json"));
    await until(() => confirmOpen(element));
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();

    // Refused on the bar, and nothing of the file kept: identity, tree, the edit since the seed.
    expect(q(element, "[data-file-error-message]").textContent).toBe('Could not open "other.json": the tree could not be built.');
    expect(element.definition).toEqual(before);
    expect(element.definition.id).toBe("sample-form-edited");
    // A later reseed starts from the form as it was, not from the refused file.
    element.componentTypeFilter = ["text"];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(element.definition.id).toBe("sample-form-edited");
    expect(element.definition.root).toEqual(before.root);
  });

  it("puts away an earlier refusal as soon as another file is chosen", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const alert = q(element, "[data-file-error]");
    chooseFile(element, new File(["these are my notes"], "notes.txt"));
    await until(() => !alert.hidden);

    const file = { id: "other", root: { id: "root", type: "form", configuration: {}, children: { content: [] } } };
    chooseFile(element, new File([JSON.stringify(file)], "other.json"));
    await until(() => confirmOpen(element));
    expect(alert.hidden).toBe(true);
    expect(q(element, "[data-file-error-message]").textContent).toBe("");
  });

  it("downloads the whole definition as JSON with a trailing newline, named after the form's id when it has no title", async () => {
    const saved = captureDownloads();
    const element = mount((el) => {
      const definition = fullDefinition();
      // A form with a title is named after it (see the next test); this one has none.
      el.definition = { ...definition, id: " Intake form / 2026 ", root: { ...definition.root, configuration: {} } };
    });
    await ready(element);
    const heard = record(element);

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("Intake-form-2026.json");
    expect(saved[0]!.type).toBe("application/json");
    const text = await readBlob(saved[0]!.blob);
    expect(text).toBe(`${JSON.stringify(element.definition, null, 2)}\n`);
    const written = JSON.parse(text) as FormDefinition;
    expect(written.localization).toEqual(sampleDefinition().localization);
    expect(written.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);
    expect(written.journey).toEqual(journeyBlock());
    expect(heard).toEqual([
      { event: "file-action", detail: { action: "download", name: "Intake-form-2026.json", definition: element.definition } }
    ]);

    // An id with nothing a file name can keep falls back to "form".
    element.builder!.controller.setIdentity({ id: "***", version: "1.0.0", schemaVersion: "1" });
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(saved[1]!.name).toBe("form.json");
  });
});

/** The sample form with its Submit button taken out: a form nobody can send. */
function withoutSubmit(): FormDefinition {
  const definition = sampleDefinition();
  const content = (definition.root.children?.content ?? []).filter((child) => child.type !== "button");
  return { ...definition, root: { ...definition.root, children: { ...definition.root.children, content } } };
}

function keyDown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("<datum-form-builder> file actions", () => {
  it("names a Download after the form's title, slugified, and after its id when the title leaves nothing", async () => {
    const saved = captureDownloads();
    const cases: Array<[unknown, string]> = [
      ["Customer Intake — Été 2026!", "customer-intake-ete-2026.json"],
      [{ default: "Plain title", locales: { "fr-CA": "Titre simple" } }, "plain-title.json"],
      // Nothing a file name can keep: the id names the file.
      ["日本語", "kept-id.json"],
      [undefined, "kept-id.json"]
    ];
    for (const [title, name] of cases) {
      const definition = sampleDefinition();
      const element = mount((el) => {
        el.definition = { ...definition, id: "kept-id", root: { ...definition.root, configuration: title === undefined ? {} : { title } } };
      });
      await ready(element);
      q<HTMLButtonElement>(element, "[data-file-download]").click();
      expect(saved.at(-1)!.name, String(JSON.stringify(title))).toBe(name);
      element.remove();
    }
  });

  it("warns once per Download of a form with no submit button, on the bar's notice and as event warnings, and not for one with a button", async () => {
    captureDownloads();
    const element = mount((el) => {
      el.definition = withoutSubmit();
    });
    await ready(element);
    const heard = record(element);
    const notice = element.shadowRoot!.querySelector<HTMLElement>("[data-file-warning]")!;
    expect(notice.hidden).toBe(true);

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("no Submit button");
    const first = heard.at(-1)!.detail as DatumFormBuilderFileActionDetail;
    expect(first.action).toBe("download");
    expect(first.warnings).toEqual([{ code: "no-submit-button", message: expect.stringContaining("no Submit button") }]);

    // Dismissible, and said again (once, not twice over) by the next Download.
    notice.querySelector<HTMLButtonElement>("[data-file-warning-dismiss]")!.click();
    expect(notice.hidden).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector("[data-file-warning-message]")!.textContent).toBe(first.warnings![0]!.message);
    expect((heard.at(-1)!.detail as DatumFormBuilderFileActionDetail).warnings).toHaveLength(1);

    // New starts a form with a Submit button: the notice goes, and the next Download is clean.
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(notice.hidden).toBe(true);
    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(notice.hidden).toBe(true);
    expect("warnings" in (heard.at(-1)!.detail as object)).toBe(false);

    // The sample form has its own Send button.
    const withButton = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(withButton);
    const heardWith = record(withButton);
    q<HTMLButtonElement>(withButton, "[data-file-download]").click();
    expect(withButton.shadowRoot!.querySelector<HTMLElement>("[data-file-warning]")!.hidden).toBe(true);
    expect("warnings" in (heardWith.at(-1)!.detail as object)).toBe(false);
  });

  it("carries the definition's tests: read back as given, announced when one is added, dropped with the last, and work a New asks about", async () => {
    const tests = { scenarios: [{ id: "test-1", source: 'test "name is kept"\n  set fullName = "Ada"\n  expect value fullName = "Ada"' }] };
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), tests };
    });
    await ready(element);
    // The seed's own block, byte for byte, until it is edited.
    expect(element.definition.tests).toEqual(tests);
    expect(element.builder!.tests).toEqual(tests);

    const heard: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) => {
      const detail = (event as CustomEvent<DatumFormBuilderChangeDetail>).detail;
      if (detail.reason !== "select") {
        heard.push(detail);
      }
    });
    // A test edit alone is an edit of the form: the page hears of it, with the block in the definition.
    const more = { scenarios: [...tests.scenarios, { id: "test-2", source: 'test "second"\n  expect hidden fullName' }] };
    element.builder!.controller.setTests(more);
    expect(heard.map((detail) => detail.reason)).toEqual(["edit"]);
    expect(heard[0]!.definition.tests).toEqual(more);
    expect(element.definition.tests).toEqual(more);

    // Removing every scenario leaves no key at all, as the localization goes with its last locale.
    element.builder!.controller.setTests(undefined);
    expect("tests" in element.definition).toBe(false);

    // A form that is otherwise empty is still not empty while it holds tests.
    const bare = mount((el) => {
      el.definition = { id: "bare", version: "1.0.0", schemaVersion: "1", root: { ...EMPTY_ROOT }, tests };
    });
    await ready(bare);
    const isEmpty = (bare.builder as unknown as { fileActions?: { isEmpty?: () => boolean } }).fileActions?.isEmpty;
    expect(isEmpty?.()).toBe(false);
  });

  it("announces a change on Apply alone, with the committed definition, not on each keystroke of a draft", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const controller = element.builder!.controller;
    controller.select("fullName");
    const heard: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) => {
      const detail = (event as CustomEvent<DatumFormBuilderChangeDetail>).detail;
      if (detail.reason !== "select") {
        heard.push(detail);
      }
    });

    for (const typed of ["N", "Na", "Nam"]) {
      controller.setDraftProperty("fullName", "label", typed);
    }
    expect(heard).toHaveLength(0);
    // The draft still counts as unsaved.
    expect(element.hasUnsavedChanges()).toBe(true);

    expect(controller.commitDraft("fullName")).toBe(true);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.reason).toBe("edit");
    const labelOf = (definition: FormDefinition): unknown =>
      (definition.root.children?.content?.find((child) => child.id === "fullName")?.configuration as { label?: unknown }).label;
    expect(labelOf(heard[0]!.definition)).toBe("Nam");
    // No stale copy: what the event carried is the definition as it stands.
    expect(heard[0]!.definition).toEqual(element.definition);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toHaveLength(1);

    // An Apply the form refuses changes nothing the page should hear of.
    controller.setDraftId("fullName", "country");
    expect(controller.commitDraft("fullName")).toBe(false);
    expect(heard).toHaveLength(1);
  });

  it("marks the form unsaved with a cue on the bar, clears it with a Download, and leaves it when the page has its own Save", async () => {
    captureDownloads();
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const dirtyChanges: boolean[] = [];
    element.addEventListener("datum-builder-dirty-change", (event) => dirtyChanges.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));
    // The shell draws the cue itself, on its bar, from saveState; the host's history slot stays free.
    const cueOf = (el: DatumFormBuilderElement): HTMLElement => q(el, "[data-save-cue]");
    const cue = (): HTMLElement | null => (cueOf(element).hidden ? null : cueOf(element));
    expect(element.dirty).toBe(false);
    expect(cue()).toBeNull();
    expect(element.builder!.querySelector("[data-save-cue]")).toBeNull();

    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Changed");
    controller.commitDraft("fullName");
    expect(element.dirty).toBe(true);
    expect(element.hasAttribute("dirty")).toBe(true);
    expect(cue()).not.toBeNull();
    // In the shell's own bar, not slotted onto the host's `history` slot, with its words (the
    // table's "shell.menu.unsaved") beside the dot and as a tooltip.
    expect(cue()!.slot).toBe("");
    expect(cue()!.closest("[slot]")).toBeNull();
    expect(element.builder!.querySelector(".save-cue")).toBeNull();
    expect(cue()!.textContent).toContain("Changes not saved");
    expect(cue()!.title).toBe("Changes not saved");
    expect(cue()!.querySelector("[aria-hidden=true]")).not.toBeNull();

    q<HTMLButtonElement>(element, "[data-file-download]").click();
    expect(element.dirty).toBe(false);
    expect(element.hasAttribute("dirty")).toBe(false);
    expect(cue()).toBeNull();
    expect(dirtyChanges).toEqual([true, false]);
    // The saved baseline is what was downloaded.
    expect(element.savedDefinition).toEqual(element.definition);

    // A page with a Save of its own owns "saved": a Download there is an export.
    const hosted = mount((el) => {
      el.definition = sampleDefinition();
      el.fileActions = { save: vi.fn() };
    });
    await ready(hosted);
    hosted.builder!.controller.select("fullName");
    hosted.builder!.controller.setDraftProperty("fullName", "label", "Changed");
    hosted.builder!.controller.commitDraft("fullName");
    expect(hosted.dirty).toBe(true);
    q<HTMLButtonElement>(hosted, "[data-file-download]").click();
    expect(hosted.dirty).toBe(true);
    expect(cueOf(hosted).hidden).toBe(false);
    expect(hosted.builder!.querySelector("[data-save-cue]")).toBeNull();
  });

  it("has the browser ask before the page is left with unsaved work, and not when there is none or the page turned it off", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    // What the browser does on a reload, a link or a closed tab; a prevented event is its question.
    const asksBeforeLeaving = (): boolean => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(asksBeforeLeaving()).toBe(false);

    // An edit still in the inspector is work the page would take with it.
    const controller = element.builder!.controller;
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Changed");
    expect(element.hasUnsavedChanges()).toBe(true);
    expect(asksBeforeLeaving()).toBe(true);

    // Applied, it is the form that differs from the saved one.
    controller.commitDraft("fullName");
    expect(element.dirty).toBe(true);
    expect(asksBeforeLeaving()).toBe(true);

    // A page that keeps the work some other way turns the question off, at any time.
    element.setAttribute("leave-guard", "off");
    expect(asksBeforeLeaving()).toBe(false);
    element.removeAttribute("leave-guard");
    expect(asksBeforeLeaving()).toBe(true);

    // Saved: nothing to lose.
    element.markSaved();
    expect(element.dirty).toBe(false);
    expect(asksBeforeLeaving()).toBe(false);

    // Off the page, the element asks nothing, whatever it held.
    controller.select("fullName");
    controller.setDraftProperty("fullName", "label", "Changed again");
    controller.commitDraft("fullName");
    expect(asksBeforeLeaving()).toBe(true);
    element.remove();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("downloads once on Ctrl or Cmd+S pressed inside the builder, and leaves the key alone elsewhere or when it is the page's", async () => {
    const saved = captureDownloads();
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const canvas = shell(element).querySelector("datum-builder-canvas")!;

    const ctrl = keyDown(canvas, { key: "s", ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(saved).toHaveLength(1);
    const meta = keyDown(canvas, { key: "S", metaKey: true });
    expect(meta.defaultPrevented).toBe(true);
    expect(saved).toHaveLength(2);

    // Not the plain key, not another chord, not from outside the builder.
    expect(keyDown(canvas, { key: "s" }).defaultPrevented).toBe(false);
    expect(keyDown(canvas, { key: "s", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(keyDown(document.body, { key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(saved).toHaveLength(2);

    // With the Download put away, the key is the page's.
    element.setAttribute("file-actions", "open");
    expect(keyDown(canvas, { key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(saved).toHaveLength(2);

    // A page's own Save takes the key (the builder's): one Save, no Download.
    const hosted = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(hosted);
    const save = vi.fn();
    hosted.fileActions = { save };
    await new Promise((resolve) => setTimeout(resolve, 0));
    keyDown(shell(hosted).querySelector("datum-builder-canvas")!, { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(2);
  });
});

describe("file actions on the PDF layouts alone (workspaces=\"pdf\")", () => {
  it("shows all three as the builder does, and those its file-actions attribute names", async () => {
    const designer = mount((el) => el.setAttribute("workspaces", "pdf"));
    await ready(designer);
    expect(shownFileItems(designer)).toEqual(["New form", "Open form file…", "Download form"]);

    designer.setAttribute("file-actions", "download");
    expect(shownFileItems(designer)).toEqual(["Download form"]);
    designer.setAttribute("file-actions", "off");
    expect(shownFileItems(designer)).toEqual([]);
    expect(designer.fileActions).toEqual({});
    designer.setAttribute("file-actions", "auto");
    expect(shownFileItems(designer)).toEqual(["New form", "Open form file…", "Download form"]);
  });
});

describe("the builder's look for the page's controls on <datum-form-builder>", () => {
  const BAR_BUTTON =
    ':where(datum-builder, datum-form-builder) > button:where([slot="toolbar-start"], [slot="toolbar"], [slot="canvas-actions"])';

  it("installs the stylesheet in the document, where a toolbar button slotted into the wrapper lives", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    // Whatever an earlier test left: the wrapper must put it there itself.
    for (const style of document.querySelectorAll("style[data-datum-host-controls]")) {
      style.remove();
    }
    const save = document.createElement("button");
    save.slot = "toolbar";
    save.textContent = "Save";
    const element = mount((el) => {
      el.append(save);
    });
    await ready(element);
    const styles = document.querySelectorAll("style[data-datum-host-controls]");
    expect(styles).toHaveLength(1);
    expect(document.head.contains(styles[0]!)).toBe(true);
    // The inner builder's own copy is in the wrapper's shadow root, which the button is not in.
    expect(save.getRootNode()).toBe(document);
    expect(save.matches(BAR_BUTTON)).toBe(true);
    expect(getComputedStyle(save).cursor).toBe("pointer");
    // A second wrapper adds nothing.
    await ready(mount());
    expect(document.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(1);
  });

  it("installs it in the page's own shadow root when the wrapper lives there, and a second wrapper there adds none", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const before = document.querySelectorAll("style[data-datum-host-controls]").length;
    const save = document.createElement("button");
    save.slot = "toolbar-start";
    save.textContent = "Save";
    const element = mount((el) => el.append(save), root);
    await ready(element);
    expect(root.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(1);
    expect(document.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(before);
    expect(save.matches(BAR_BUTTON)).toBe(true);

    const print = document.createElement("button");
    print.slot = "toolbar";
    print.textContent = "Print";
    const designer = mount((el) => {
      el.setAttribute("workspaces", "pdf");
      el.append(print);
    }, root);
    await ready(designer);
    expect(root.querySelectorAll("style[data-datum-host-controls]")).toHaveLength(1);
    expect(print.matches(BAR_BUTTON)).toBe(true);
  });
});
