import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { clearPanelMemory, readPanelMemory } from "@argusvane/datum-engine";
import type { FormChromePart, FormDefinition, PdfGeneratedLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  clearPanelMemory("chrome-t");
});

/** The sample form with a header its author composed: the title, then a line of text (each part has the id its translations are keyed by). */
function withChrome(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.configuration = {
    ...(definition.root.configuration as Record<string, unknown>),
    chrome: { header: [{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome" }] }
  };
  return definition;
}

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

async function mount(definition: FormDefinition = withChrome(), setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

type ChromePanel = HTMLElement & { focusRegion(region: "header" | "footer"): void };

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const stripItem = (element: DatumFormBuilderElement, panel: string): HTMLButtonElement =>
  shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;
const panel = (element: DatumFormBuilderElement): ChromePanel => shell(element).querySelector("datum-builder-chrome-panel") as ChromePanel;
const panelRoot = (element: DatumFormBuilderElement): ShadowRoot => panel(element).shadowRoot!;
const region = (element: DatumFormBuilderElement, name: "header" | "footer"): HTMLElement =>
  panelRoot(element).querySelector<HTMLElement>(`[data-chrome-region="${name}"]`)!;
/** The Form panel's shadow root, opened first: a panel behind its strip item does not paint. */
const formPanelRoot = (element: DatumFormBuilderElement): ShadowRoot => {
  const form = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  if (form.hidden) {
    stripItem(element, "form").click();
  }
  return form.shadowRoot!;
};
const deepActive = (): Element | null => {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};
const draft = (element: DatumFormBuilderElement, path: string): unknown => element.builder!.activeController.draftProperty("root", path);
const committedChrome = (element: DatumFormBuilderElement): { header?: FormChromePart[]; footer?: FormChromePart[] } | undefined =>
  (element.definition.root.configuration as { chrome?: unknown } | undefined)?.chrome as { header?: FormChromePart[]; footer?: FormChromePart[] } | undefined;
/** A part's text, for the part types that carry one. */
const partText = (part: FormChromePart | undefined): unknown => (part as { text?: unknown } | undefined)?.text;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  select.focus();
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the Header & footer panel", () => {
  it("is a strip item after Form, opening a docked panel that lists both regions as the form carries them", async () => {
    const element = await mount();
    const item = stripItem(element, "chrome");
    expect(item.getAttribute("aria-label")).toBe("Header and footer");
    expect(item.previousElementSibling).toBe(stripItem(element, "form"));
    expect(item.querySelector("svg")).toBeTruthy();
    expect(panel(element).hidden).toBe(true);

    item.click();
    expect(element.builder!.panel).toBe("chrome");
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(panel(element).hidden).toBe(false);
    // The panel's body is a chunk of its own, fetched on this first open.
    await until(() => panelRoot(element)?.querySelector(".chrome-head"));
    expect(panelRoot(element).querySelector(".chrome-head")?.textContent).toBe("Header & footer");
    // The header's two parts, keyed within their region; the footer empty.
    expect([...region(element, "header").querySelectorAll("[data-chrome-part-row]")].map((row) => (row as HTMLElement).dataset.chromePartRow)).toEqual(["0", "1"]);
    expect(region(element, "header").querySelector<HTMLSelectElement>('[data-chrome-row="0"][data-chrome-field="type"]')?.value).toBe("form-title");
    expect(region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')?.value).toBe("Welcome");
    expect(region(element, "footer").querySelectorAll("[data-chrome-part-row]")).toHaveLength(0);
    expect(region(element, "footer").textContent).toContain("Nothing in the footer yet.");
    // Nothing edited: nothing to save.
    expect(panelRoot(element).querySelector("[data-inspector-save]")?.hasAttribute("disabled")).toBe(true);
    expect(panelRoot(element).querySelector(".dirty-flag")).toBeNull();

    // The same item closes it again.
    item.click();
    expect(element.builder!.panel).toBeUndefined();
    expect(panel(element).hidden).toBe(true);
  });

  it("adds, types into, places, reorders and removes parts straight in the root's draft, keeps the caret across the repaint, previews on the canvas, and Save commits", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    const footer = (): HTMLElement => region(element, "footer");
    const header = (): HTMLElement => region(element, "header");

    // Add to the footer: the picker's type, and focus lands on the new part's own row.
    choose(footer().querySelector<HTMLSelectElement>('[data-chrome-add-type=""]')!, "text");
    footer().querySelector<HTMLButtonElement>('[data-chrome-add=""]')!.click();
    expect(draft(element, "chrome.footer")).toEqual([{ id: "part_1", type: "text", text: "" }]);
    let active = deepActive() as HTMLElement;
    expect(active.dataset.chromeField).toBe("type");
    expect(active.closest("[data-chrome-region]")).toBe(footer());
    // The header, keyed the same way, was not the region that changed.
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome" }]);

    // Typing reaches the draft on every keystroke as a live write: the box is never replaced
    // (so caret and composition stay), the footer is refreshed in place.
    const box = footer().querySelector<HTMLInputElement>('[data-chrome-row="0"][data-chrome-field="text"]')!;
    type(box, "Contact us");
    expect(draft(element, "chrome.footer")).toEqual([{ id: "part_1", type: "text", text: "Contact us" }]);
    active = deepActive() as HTMLElement;
    expect(active).toBe(box); // the very box typed in, no repaint…
    expect((active as HTMLInputElement).value).toBe("Contact us"); // …showing what was typed…
    expect(active.closest("[data-chrome-region]")).toBe(footer()); // …in the same region.
    expect((active as HTMLInputElement).selectionStart).toBe("Contact us".length);
    expect(panelRoot(element).querySelector(".dirty-flag")?.textContent).toBe("Not applied");
    expect(panelRoot(element).querySelector("[data-inspector-save]")?.hasAttribute("disabled")).toBe(false);

    // Its place on the row.
    choose(footer().querySelector<HTMLSelectElement>('[data-chrome-row="0"][data-chrome-field="align"]')!, "center");
    expect(draft(element, "chrome.footer")).toEqual([{ id: "part_1", type: "text", text: "Contact us", align: "center" }]);

    // The canvas previews the draft: the footer line is on the page before anything is saved.
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewRoot(): ShadowRoot | undefined };
    await until(() => [...(canvas.previewRoot()?.querySelectorAll('[data-chrome-part="text"]') ?? [])].some((part) => part.textContent?.includes("Contact us")));

    // Reorder the header: the second part up, focus following it — onto the arrow that
    // brings it back, since at the top "up" is disabled.
    header().querySelector<HTMLButtonElement>('[data-chrome-move="1:-1"]')!.click();
    expect((draft(element, "chrome.header") as FormChromePart[]).map((part) => part.type)).toEqual(["text", "form-title"]);
    active = deepActive() as HTMLElement;
    expect(active.dataset.chromeMove).toBe("0:1");
    expect(active.closest("[data-chrome-region]")).toBe(header());
    // And down again: at the bottom of a two-part list "down" is disabled in turn, so focus
    // lands on "up" once more.
    (active as HTMLButtonElement).click();
    expect((draft(element, "chrome.header") as FormChromePart[]).map((part) => part.type)).toEqual(["form-title", "text"]);
    expect((deepActive() as HTMLElement).dataset.chromeMove).toBe("1:-1");
    header().querySelector<HTMLButtonElement>('[data-chrome-move="1:-1"]')!.click();

    // Remove the title, focus going to the region's Add.
    header().querySelector<HTMLButtonElement>('[data-chrome-remove="1"]')!.click();
    expect(draft(element, "chrome.header")).toEqual([{ id: "welcome", type: "text", text: "Welcome" }]);
    expect((deepActive() as HTMLElement).dataset.chromeAdd).toBe("");

    // Nothing has reached the definition yet; Save lands the whole root draft.
    expect(committedChrome(element)?.footer).toBeUndefined();
    panelRoot(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => partText(committedChrome(element)?.footer?.[0]) === "Contact us");
    expect(committedChrome(element)).toEqual({
      header: [{ id: "welcome", type: "text", text: "Welcome" }],
      footer: [{ id: "part_1", type: "text", text: "Contact us", align: "center" }]
    });
    expect(element.builder!.activeController.hasPendingChanges("root")).toBe(false);
    expect(panelRoot(element).querySelector(".dirty-flag")).toBeNull();
  });

  it("changes a part's type in place, keeps its place, and edits a group's own parts under it", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    const header = (): HTMLElement => region(element, "header");

    choose(header().querySelector<HTMLSelectElement>('[data-chrome-row="1"][data-chrome-field="align"]')!, "end");
    choose(header().querySelector<HTMLSelectElement>('[data-chrome-row="1"][data-chrome-field="type"]')!, "group");
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "group", parts: [], align: "end" }]);
    // The type box kept focus through the repaint that changed its row's shape.
    expect((deepActive() as HTMLElement).dataset.chromeField).toBe("type");

    // Into the group: a nested Add with its own picker (no group inside a group), keyed under the group.
    const nested = header().querySelector<HTMLElement>('[data-chrome-list="1"]')!;
    expect([...nested.querySelectorAll<HTMLOptionElement>('[data-chrome-add-type="1"] option')].map((option) => option.value)).not.toContain("group");
    choose(nested.querySelector<HTMLSelectElement>('[data-chrome-add-type="1"]')!, "image");
    nested.querySelector<HTMLButtonElement>('[data-chrome-add="1"]')!.click();
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "group", parts: [{ id: "part_1", type: "image", src: "" }], align: "end" }]);
    type(header().querySelector<HTMLInputElement>('[data-chrome-row="1.0"][data-chrome-field="src"]')!, "/logo.svg");
    type(header().querySelector<HTMLInputElement>('[data-chrome-row="1.0"][data-chrome-field="width"]')!, "120");
    expect(draft(element, "chrome.header")).toEqual([
      { id: "title", type: "form-title" },
      { id: "welcome", type: "group", parts: [{ id: "part_1", type: "image", src: "/logo.svg", width: 120 }], align: "end" }
    ]);
    // A cleared optional text is dropped rather than kept empty; a cleared size likewise.
    type(header().querySelector<HTMLInputElement>('[data-chrome-row="1.0"][data-chrome-field="width"]')!, "");
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "group", parts: [{ id: "part_1", type: "image", src: "/logo.svg" }], align: "end" }]);
  });

  it("Cancel throws the drafted parts away, and emptying both regions leaves no chrome behind", async () => {
    const element = await mount(sampleDefinition());
    stripItem(element, "chrome").click();
    const controller = element.builder!.activeController;
    const header = (): HTMLElement => region(element, "header");

    header().querySelector<HTMLButtonElement>('[data-chrome-add=""]')!.click();
    // A part the builder makes carries an id, unique across both regions: the key its translations live under.
    expect(draft(element, "chrome.header")).toEqual([{ id: "part_1", type: "form-title" }]);
    expect(controller.hasPendingChanges("root")).toBe(true);
    // Back to nothing: the region is cleared, and with it the `chrome` block — the draft is clean again.
    header().querySelector<HTMLButtonElement>('[data-chrome-remove="0"]')!.click();
    expect(draft(element, "chrome")).toBeUndefined();
    expect(controller.hasPendingChanges("root")).toBe(false);
    expect(panelRoot(element).querySelector("[data-inspector-save]")?.hasAttribute("disabled")).toBe(true);

    choose(header().querySelector<HTMLSelectElement>('[data-chrome-add-type=""]')!, "text");
    header().querySelector<HTMLButtonElement>('[data-chrome-add=""]')!.click();
    type(header().querySelector<HTMLInputElement>('[data-chrome-row="0"][data-chrome-field="text"]')!, "x");
    expect(controller.hasPendingChanges("root")).toBe(true);
    panelRoot(element).querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.click();
    expect(controller.hasPendingChanges("root")).toBe(false);
    expect(draft(element, "chrome")).toBeUndefined();
    expect(header().querySelectorAll("[data-chrome-part-row]")).toHaveLength(0);
    expect((element.definition.root.configuration as { chrome?: unknown } | undefined)?.chrome).toBeUndefined();
  });

  it("Enter in a box saves and Escape discards, as in the inspector", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    const box = (): HTMLInputElement => region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')!;
    type(box(), "Hello");
    box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome" }]);
    type(box(), "Hello again");
    box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => partText(committedChrome(element)?.header?.[1]) === "Hello again");
  });

  it("the Form panel's Header and Footer rows summarise the regions and open the panel on the one clicked", async () => {
    const element = await mount();
    const form = formPanelRoot(element);
    expect(form.querySelector('[data-chrome-open="header"]')?.parentElement?.querySelector("[data-chrome-count]")?.textContent).toBe("Form title, Text");
    expect(form.querySelector('[data-chrome-open="footer"]')?.parentElement?.querySelector("[data-chrome-count]")?.textContent).toBe("Nothing yet");
    // The dialog is gone: nothing in the Form panel edits the parts.
    expect(form.querySelector("[data-chrome-edit], dialog[data-chrome-dialog]")).toBeNull();

    form.querySelector<HTMLButtonElement>('[data-chrome-open="footer"]')!.click();
    expect(element.builder!.panel).toBe("chrome");
    expect(panel(element).hidden).toBe(false);
    // The footer is empty, so its Add row's picker is the first control.
    const active = deepActive() as HTMLElement;
    expect(active.dataset.chromeAddType).toBe("");
    expect(active.closest("[data-chrome-region]")).toBe(region(element, "footer"));

    formPanelRoot(element).querySelector<HTMLButtonElement>('[data-chrome-open="header"]')!.click();
    expect((deepActive() as HTMLElement).dataset.chromeField).toBe("type");
    expect((deepActive() as HTMLElement).closest("[data-chrome-region]")).toBe(region(element, "header"));
  });

  it("draws the unsaved-changes prompt for the root when it is the panel on screen, and its Save carries on", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    type(region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')!, "Edited");
    const controller = element.builder!.activeController;
    let left = false;
    expect(controller.requestLeave(() => { left = true; })).toBe(false);
    const prompt = panelRoot(element).querySelector<HTMLDialogElement>("dialog[data-unsaved-prompt]");
    expect(prompt).toBeTruthy();
    expect(prompt?.hasAttribute("open")).toBe(true);
    prompt!.querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    expect(left).toBe(true);
    await until(() => partText(committedChrome(element)?.header?.[1]) === "Edited");
    expect(panelRoot(element).querySelector("dialog[data-unsaved-prompt]")).toBeNull();
  });

  it("has Parts as its one tab, and the JSON behind a ⋯ menu beside the tablist, as the inspector has", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    // An edit first: the menu opens and closes over a drafted change without a repaint.
    type(region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')!, "Edited");
    const root = panelRoot(element);
    const tablist = root.querySelector<HTMLElement>('.inspector-tabs > [role="tablist"]')!;
    expect([...tablist.children].map((tab) => [tab.getAttribute("role"), (tab as HTMLElement).dataset.chromeTab, tab.getAttribute("aria-selected")])).toEqual([
      ["tab", "parts", "true"]
    ]);
    // The ⋯ and its menu sit outside the tablist, which may own tabs only.
    const more = root.querySelector<HTMLButtonElement>(".inspector-tabs > [data-chrome-more]")!;
    expect(tablist.contains(more)).toBe(false);
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-label")).toBe("More");
    const menu = root.querySelector<HTMLElement>(".inspector-tabs > [data-chrome-menu]")!;
    expect(more.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.hidden).toBe(true);
    expect([...menu.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["View JSON"]);

    // ⋯ opens the menu at its item; Escape closes it, focus back on the ⋯, the draft untouched.
    more.click();
    expect(menu.hidden).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect((deepActive() as HTMLElement).getAttribute("role")).toBe("menuitem");
    // The arrows walk the items, wrapping at the ends.
    deepActive()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((deepActive() as HTMLElement).dataset.chromeTab).toBe("json");
    deepActive()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(deepActive()).toBe(more);
    expect((draft(element, "chrome.header") as FormChromePart[])[1]).toMatchObject({ text: "Edited" });
    // Down on the ⋯ opens it too; a click elsewhere in the panel closes it.
    more.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu.hidden).toBe(false);
    root.querySelector<HTMLElement>("[data-chrome-body]")!.click();
    expect(menu.hidden).toBe(true);
  });

  it("shows the chrome block as drafted from View JSON, read-only, the ⋯ pressed while it is up, following the parts", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    const root = panelRoot(element);
    expect(root.querySelector("[data-json-view]")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-chrome-more]")!.click();
    root.querySelector<HTMLButtonElement>('[data-chrome-menu] [data-chrome-tab="json"]')!.click();
    expect(root.querySelector("[data-chrome-menu]")?.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector("[data-chrome-more]")?.classList.contains("active")).toBe(true);
    expect(root.querySelector('[data-chrome-tab="parts"]')?.classList.contains("active")).toBe(false);
    expect(root.querySelector('[data-chrome-tab="parts"]')?.getAttribute("aria-selected")).toBe("false");
    expect(root.querySelector("[data-chrome-region]")).toBeNull();
    const source = (): HTMLElement => root.querySelector<HTMLElement>("[data-json-view]")!;
    expect(JSON.parse(source().textContent ?? "")).toEqual({ header: [{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome" }] });
    // The <pre> is the source, hidden behind the read-only editor mounted over it once the
    // editor's chunk has loaded (json-viewer-loader.ts).
    await until(() => root.querySelector(".json-editor > .cm-editor"));
    expect(source().hidden).toBe(true);
    // Focus is back on the ⋯, across the repaint.
    expect((deepActive() as HTMLElement).dataset.chromeMore).toBe("");
    // Save and Cancel stay at hand either way.
    expect(root.querySelector("[data-inspector-save]")).toBeTruthy();

    // Back to the parts, an edit, and the JSON follows it — the frame the Form panel sets included.
    root.querySelector<HTMLButtonElement>('[data-chrome-tab="parts"]')!.click();
    expect(root.querySelector("[data-json-view]")).toBeNull();
    expect(root.querySelector(".cm-editor")).toBeNull();
    type(region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')!, "Welcome back");
    element.builder!.activeController.setDraftProperty("root", "chrome.frame", "outlined");
    root.querySelector<HTMLButtonElement>('[data-chrome-tab="json"]')!.click();
    expect(JSON.parse(source().textContent ?? "")).toEqual({ header: [{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome back" }], frame: "outlined" });
    // A form with no chrome shows an empty block rather than nothing.
    const bare = await mount(sampleDefinition());
    stripItem(bare, "chrome").click();
    panelRoot(bare).querySelector<HTMLButtonElement>('[data-chrome-tab="json"]')!.click();
    expect(panelRoot(bare).querySelector("[data-json-view]")?.textContent).toBe("{}");
  });

  it("is remembered under persist-panels, and steps aside on another mode's tab, where the form's chrome is not", async () => {
    const element = await mount(
      { ...withChrome(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } },
      (el) => el.setAttribute("persist-panels", "chrome-t")
    );
    await until(() => element.pdfMode !== undefined);
    stripItem(element, "chrome").click();
    expect(readPanelMemory("chrome-t")?.panel).toBe("chrome");

    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    expect(stripItem(element, "chrome").hidden).toBe(true);
    expect(element.builder!.panel).toBe("form");
    expect(panel(element).hidden).toBe(true);

    element.mode = "form";
    await until(() => element.mode === "form");
    expect(stripItem(element, "chrome").hidden).toBe(false);
    stripItem(element, "chrome").click();
    expect(region(element, "header").querySelectorAll("[data-chrome-part-row]")).toHaveLength(2);
  });
});

describe("the Header & footer panel paint contract", () => {
  it("typing in a part's box paints nothing, keeps the box and its focus, refreshes the footer in place, and commits plainly on blur", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    const box = region(element, "header").querySelector<HTMLInputElement>('[data-chrome-field="text"]')!;
    const proto = Object.getPrototypeOf(panel(element)) as { render(): void };
    const original = proto.render;
    let paints = 0;
    proto.render = function (this: unknown) {
      paints++;
      return original.call(this);
    };
    try {
      expect(panelRoot(element).querySelector(".dirty-flag")).toBeNull();
      for (const text of ["Hi", "Hi!", "Hi!!"]) {
        type(box, text);
      }
      expect(paints).toBe(0);
      expect(panelRoot(element).querySelector('[data-chrome-field="text"]')).toBe(box);
      expect(deepActive()).toBe(box);
      expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Hi!!" }]);
      expect(panelRoot(element).querySelector(".dirty-flag")?.textContent).toBe("Not applied");
      expect(panelRoot(element).querySelector("[data-inspector-save]")?.hasAttribute("disabled")).toBe(false);
    } finally {
      proto.render = original;
    }
    box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(draft(element, "chrome.header")).toEqual([{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Hi!!" }]);
  });

  it("the panel's title is a heading", async () => {
    const element = await mount();
    stripItem(element, "chrome").click();
    expect(panelRoot(element).querySelector("h2")?.textContent).toContain("Header");
  });
});

describe("a chrome part with no usable id", () => {
  /** A header whose second part has no id and a footer part that repeats the header's: both are drawn untranslated, never dropped. */
  function withIdlessParts(): FormDefinition {
    const definition = sampleDefinition();
    definition.root.configuration = {
      ...(definition.root.configuration as Record<string, unknown>),
      chrome: {
        header: [{ id: "title", type: "form-title" }, { type: "text", text: "No id" }, { id: "__proto__", type: "text", text: "Unsafe" }],
        footer: [{ id: "title", type: "text", text: "Repeats" }]
      }
    };
    return definition;
  }

  it("is listed with the others, and the first edit gives each a fresh id instead of dropping it", async () => {
    const element = await mount(withIdlessParts());
    stripItem(element, "chrome").click();
    await until(() => panelRoot(element)?.querySelector(".chrome-head"));
    expect(region(element, "header").querySelectorAll("[data-chrome-part-row]")).toHaveLength(3);
    expect(region(element, "footer").querySelectorAll("[data-chrome-part-row]")).toHaveLength(1);
    // Nothing is written until an edit.
    expect(panelRoot(element).querySelector("[data-inspector-save]")?.hasAttribute("disabled")).toBe(true);

    const box = region(element, "header").querySelector<HTMLInputElement>('[data-chrome-row="1"][data-chrome-field="text"]')!;
    expect(box.value).toBe("No id");
    type(box, "Now with an id");
    const header = draft(element, "chrome.header") as Array<{ id?: string; text?: string }>;
    expect(header.map((part) => part.text)).toEqual([undefined, "Now with an id", "Unsafe"]);
    expect(header.map((part) => part.id)).toEqual(["title", "part_1", "part_2"]);
    // The other region was given its id in the same draft, so one Save writes both.
    expect(draft(element, "chrome.footer")).toEqual([{ id: "part_3", type: "text", text: "Repeats" }]);
    panelRoot(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    const ids = [...(committedChrome(element)?.header ?? []), ...(committedChrome(element)?.footer ?? [])].map((part) => part.id);
    expect(ids).toEqual(["title", "part_1", "part_2", "part_3"]);
  });
});

