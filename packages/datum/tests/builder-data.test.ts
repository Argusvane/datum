import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Data workspace: the schema table, its views, and the answer's storage settings
 * through the draft; its own Import dialog and the "?" on its checks.
 */

afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const surface = (element: DatumFormBuilderElement): ShadowRoot | undefined =>
  shell(element).querySelector("datum-builder-data")?.shadowRoot ?? undefined;
const data = (element: DatumFormBuilderElement): ShadowRoot => surface(element)!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const fire = (target: Element, type: "input" | "change"): void => {
  target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
};
const node = (element: DatumFormBuilderElement, id: string) => element.builder!.controller.snapshot().children!.content!.find((entry) => entry.id === id)!;
const contentIds = (element: DatumFormBuilderElement): string[] => (element.builder!.controller.snapshot().children?.content ?? []).map((entry) => entry.id);
const importDialog = (element: DatumFormBuilderElement): HTMLDialogElement => data(element).querySelector<HTMLDialogElement>("dialog[data-import-dialog]")!;
const importButton = (element: DatumFormBuilderElement): HTMLButtonElement => data(element).querySelector<HTMLButtonElement>(".data-tools [data-data-import]")!;
const escape = (target: Element): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
};

/** Opens Import from the heading's button. */
function openImport(element: DatumFormBuilderElement): HTMLDialogElement {
  importButton(element).focus();
  importButton(element).click();
  return importDialog(element);
}

/** Types into the Import box and reads it at once, as a paste followed by leaving the box does. */
function paste(element: DatumFormBuilderElement, text: string): void {
  const box = importDialog(element).querySelector<HTMLTextAreaElement>("[data-model-input]")!;
  box.focus();
  box.value = text;
  fire(box, "input");
  fire(box, "change");
}

async function mountInData(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  element.builder!.setWorkspace("data");
  await until(() => surface(element)?.querySelector("[data-data-row]"));
  return element;
}

const rowCells = (element: DatumFormBuilderElement): string[][] =>
  [...data(element).querySelectorAll("tbody tr")].map((row) => [
    row.querySelector("[data-data-row]")!.textContent!,
    row.querySelector("code")!.textContent!,
    row.querySelectorAll("td")[1]!.textContent!,
    row.querySelectorAll("td")[2]!.textContent!
  ]);

describe("the Data workspace", () => {
  it("draws the schema table in the canvas's place, with no drawer open", async () => {
    const element = await mountInData();
    expect(element.builder!.panel).toBeUndefined();
    expect(shell(element).querySelector<HTMLElement>("[data-data-host]")!.hidden).toBe(false);
    expect(rowCells(element)).toEqual([
      ["Full name", "fullName", "Text", "Yes"],
      ["Country", "country", "One of a list", "No"],
      ["Subscribe", "subscribe", "Yes or no", "No"],
      ["Email", "email", "Text", "No"]
    ]);
    expect(data(element).querySelector('[data-data-row="email"]')!.parentElement!.querySelector(".badge")!.textContent).toBe("Shown by a rule");
    expect(data(element).querySelector(".data-title p")!.textContent).toContain("4 fields");
  });

  it("opens an answer's storage settings from its row, and applies a new data key as one undo step", async () => {
    const element = await mountInData();
    const controller = element.builder!.controller;
    data(element).querySelector<HTMLButtonElement>('[data-data-row="fullName"]')!.click();
    expect(controller.selectedComponentId()).toBe("fullName");
    await until(() => data(element).querySelector("[data-data-editor]"));
    expect(data(element).querySelector("[data-data-editor] h2")!.textContent).toBe("Full name");
    const key = data(element).querySelector<HTMLInputElement>("[data-data-key]")!;
    key.focus();
    key.value = "full_name";
    fire(key, "input");
    expect(data(element).querySelector<HTMLInputElement>("[data-data-saves-to]")!.value).toBe("full_name");
    expect(data(element).querySelector<HTMLElement>("[data-data-dirty]")!.hidden).toBe(false);
    expect(data(element).activeElement).toBe(key);
    expect(element.hasUnsavedChanges()).toBe(true);
    data(element).querySelector<HTMLButtonElement>("[data-data-apply]")!.click();
    expect((node(element, "fullName").configuration as Record<string, unknown>).dataKey).toBe("full_name");
    await until(() => rowCells(element)[0]![1] === "full_name");
    controller.undo();
    expect((node(element, "fullName").configuration as Record<string, unknown>).dataKey).toBeUndefined();
  });

  it("holds back a key that puts the answer where another one is", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-row="email"]')!.click();
    await until(() => data(element).querySelector("[data-data-key]"));
    const key = data(element).querySelector<HTMLInputElement>("[data-data-key]")!;
    key.focus();
    key.value = "fullName";
    fire(key, "input");
    await until(() => data(element).querySelector("[data-data-key-problem] .problem"));
    expect(key.getAttribute("aria-invalid")).not.toBeNull();
    data(element).querySelector<HTMLButtonElement>("[data-data-apply]")!.click();
    expect((node(element, "email").configuration as Record<string, unknown>).dataKey).toBeUndefined();
    expect(element.builder!.controller.hasPendingChanges("email")).toBe(true);
  });

  it("sets what happens to a hidden answer and whether PDFs carry it, through the same draft", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-row="email"]')!.click();
    await until(() => data(element).querySelector("[data-data-hidden]"));
    const clear = data(element).querySelector<HTMLInputElement>('[data-data-hidden][value="clear"]')!;
    clear.checked = true;
    fire(clear, "change");
    const pdf = data(element).querySelector<HTMLInputElement>("[data-data-pdf]")!;
    pdf.checked = false;
    fire(pdf, "change");
    data(element).querySelector<HTMLButtonElement>("[data-data-apply]")!.click();
    expect(node(element, "email").configuration).toMatchObject({ hiddenValueBehavior: "clear", pdf: { exclude: true } });
  });

  it("asks before a workspace switch walks past a draft, in Data's own prompt, never the hidden inspector's", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-row="fullName"]')!.click();
    await until(() => data(element).querySelector("[data-data-key]"));
    const key = data(element).querySelector<HTMLInputElement>("[data-data-key]")!;
    key.value = "name";
    fire(key, "input");
    element.builder!.setWorkspace("form");
    expect(element.builder!.workspace).toBe("data");
    await until(() => data(element).querySelector("[data-unsaved-prompt]"));
    expect(inspector(element).querySelector("[data-unsaved-prompt]")).toBeNull();
    data(element).querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    expect(element.builder!.workspace).toBe("form");
    expect(element.builder!.controller.hasPendingChanges("fullName")).toBe(false);
  });

  it("shows the schema as JSON Schema and an example", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-view="schema"]')!.click();
    const schema = JSON.parse(data(element).querySelector("[data-json-view]")!.textContent!) as { $schema: string; properties: Record<string, unknown> };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(schema.properties)).toEqual(["fullName", "country", "subscribe", "email"]);
    data(element).querySelector<HTMLButtonElement>('[data-data-view="example"]')!.click();
    expect(Object.keys(JSON.parse(data(element).querySelector("[data-json-view]")!.textContent!) as object)).toContain("fullName");
  });

  it("keeps the heading's buttons the same in every view: Copy sits over the JSON, not among them", async () => {
    const element = await mountInData();
    const tools = (): string[] => [...data(element).querySelectorAll(".data-tools button")].map((button) => button.textContent!);
    const expected = ["Table", "JSON Schema", "Example", "Import…"];
    expect(tools()).toEqual(expected);
    expect(data(element).querySelector("[data-data-copy]")).toBeNull();
    for (const view of ["schema", "example", "table"]) {
      data(element).querySelector<HTMLButtonElement>(`[data-data-view="${view}"]`)!.click();
      expect(tools()).toEqual(expected);
      expect(data(element).querySelector(".data-tools [data-data-copy]")).toBeNull();
    }

    data(element).querySelector<HTMLButtonElement>('[data-data-view="schema"]')!.click();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    data(element).querySelector<HTMLButtonElement>(".json-bar [data-data-copy]")!.click();
    expect(writeText).toHaveBeenCalledWith(data(element).querySelector("[data-json-view]")!.textContent);
    await until(() => data(element).querySelector("[data-data-live]")!.textContent === "Copied.");
  });
});

describe("Import in the Data workspace", () => {
  it("opens its own dialog, never a drawer, with focus in the text box", async () => {
    const element = await mountInData();
    const dialog = openImport(element);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("data-import-title");
    expect(data(element).getElementById("data-import-title")!.textContent).toBe("Import a data model");
    expect(element.builder!.panel).toBeUndefined();
    const box = dialog.querySelector<HTMLTextAreaElement>("[data-model-input]")!;
    expect(data(element).activeElement).toBe(box);
    expect(box.getAttribute("aria-label")).toBe("JSON sample or JSON Schema");
    expect(box.getAttribute("aria-describedby")).toBe("data-import-error");
  });

  it("reads a pasted sample, says what it adds, and adds the missing fields as one undo step", async () => {
    const element = await mountInData();
    const applied: unknown[] = [];
    element.addEventListener("builder-data-model-apply", (event) => applied.push((event as CustomEvent).detail));
    const dialog = openImport(element);
    paste(element, JSON.stringify({ fullName: "Ada", phone: "555-0100" }));
    await until(() => dialog.querySelector("[data-model-counts]"));
    expect(dialog.querySelector<HTMLElement>('[data-model-row="phone"]')!.dataset.modelEntryStatus).toBe("new");
    expect(dialog.querySelector<HTMLElement>('[data-model-row="fullName"]')!.dataset.modelEntryStatus).toBe("present");
    expect(dialog.querySelector("[data-model-read-as] option[value='auto']")!.textContent).toBe("Auto (sample)");
    const add = dialog.querySelector<HTMLButtonElement>("[data-model-add]")!;
    expect(add.textContent).toBe("Add missing fields (1)");

    add.click();
    expect(contentIds(element)).toContain("phone");
    expect(applied).toEqual([{ action: "add-missing", source: "sample", ids: ["phone"], skipped: [] }]);
    // The dialog closes on the table, which now lists the new answer, and says what was built.
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(data(element).activeElement).toBe(importButton(element));
    expect(rowCells(element).map((cells) => cells[1])).toContain("phone");
    expect(data(element).querySelector("[data-data-notice]")!.textContent).toBe("Added 1 component. Undo takes it all back in one step.");
    expect(data(element).querySelector("[data-data-live]")!.textContent).toBe("Added 1 component. Undo takes it all back in one step.");

    element.builder!.controller.undo();
    expect(contentIds(element)).not.toContain("phone");
    // The message would mislead once the form changed again.
    await until(() => !data(element).querySelector("[data-data-notice]"));
  });

  it("asks before replacing; Escape steps back from the confirm, then closes the dialog, which keeps its text", async () => {
    const element = await mountInData();
    const before = contentIds(element);
    let dialog = openImport(element);
    paste(element, JSON.stringify({ title: "Dr", guests: 2 }));
    await until(() => dialog.querySelector("[data-model-replace]"));
    dialog.querySelector<HTMLButtonElement>("[data-model-replace]")!.click();
    await until(() => dialog.querySelector("[data-model-confirm]"));
    const cancel = dialog.querySelector<HTMLButtonElement>("[data-model-replace-cancel]")!;
    expect(data(element).activeElement).toBe(cancel);

    escape(cancel);
    expect(dialog.querySelector("[data-model-confirm]")).toBeNull();
    expect(dialog.hasAttribute("open")).toBe(true);
    const replace = dialog.querySelector<HTMLButtonElement>("[data-model-replace]")!;
    expect(data(element).activeElement).toBe(replace);

    escape(replace);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(data(element).activeElement).toBe(importButton(element));
    expect(contentIds(element)).toEqual(before);

    dialog = openImport(element);
    expect(dialog.querySelector<HTMLTextAreaElement>("[data-model-input]")!.value).toBe(JSON.stringify({ title: "Dr", guests: 2 }));
    await until(() => dialog.querySelector("[data-model-replace]"));
    dialog.querySelector<HTMLButtonElement>("[data-model-replace]")!.click();
    await until(() => dialog.querySelector("[data-model-replace-confirm]"));
    dialog.querySelector<HTMLButtonElement>("[data-model-replace-confirm]")!.click();
    expect(contentIds(element).slice(0, 2)).toEqual(["title", "guests"]);
    expect(dialog.hasAttribute("open")).toBe(false);
    element.builder!.controller.undo();
    expect(contentIds(element)).toEqual(before);
  });

  it("closes from its Close button, and says where pasted JSON goes wrong", async () => {
    const element = await mountInData();
    const dialog = openImport(element);
    paste(element, '{\n  "a": 1,\n  "b": \n}');
    await until(() => dialog.querySelector("[data-model-input-error]")?.textContent);
    expect(dialog.querySelector("[data-model-input-error]")!.textContent).toMatch(/\(line 4, column 1\)/);
    expect(dialog.querySelector("[data-model-input]")!.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.querySelector("[data-model-counts]")).toBeNull();
    dialog.querySelector<HTMLButtonElement>("[data-import-close]")!.click();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(data(element).activeElement).toBe(importButton(element));
  });
});

describe("the checks on the server", () => {
  it("say what is checked, with the note on the server behind a ? beside the heading", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-row="fullName"]')!.click();
    await until(() => data(element).querySelector("[data-data-editor]"));
    const checks = data(element).querySelector(".checks")!.textContent!;
    expect(checks).toMatch(/^Required/);
    expect(checks).not.toContain("The server runs the same checks");

    const toggle = (): HTMLButtonElement => data(element).querySelector<HTMLButtonElement>('[data-data-help="checks"]')!;
    const note = (): HTMLElement => data(element).getElementById("data-checks-help")!;
    expect(toggle().textContent).toBe("?");
    expect(toggle().getAttribute("aria-label")).toBe("Help: Checks on the server");
    expect(toggle().getAttribute("aria-controls")).toBe("data-checks-help");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().closest(".row-label-line")!.textContent).toContain("Checks on the server");
    expect(note().hidden).toBe(true);
    expect(note().textContent).toBe("The server runs the same checks when the form is sent.");

    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(note().hidden).toBe(false);

    // Open still on the next answer's settings, drawn afresh.
    data(element).querySelector<HTMLButtonElement>('[data-data-row="email"]')!.click();
    await until(() => data(element).querySelector("[data-data-editor] h2")?.textContent === "Email");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(note().hidden).toBe(false);
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(note().hidden).toBe(true);
  });
});

describe("the Data row drawer at the narrow tiers", () => {
  it("has a Close in its head, shown wherever the drawer overlays the table, not only on a phone", async () => {
    const element = await mountInData();
    data(element).querySelector<HTMLButtonElement>('[data-data-row="fullName"]')!.click();
    await until(() => data(element).querySelector("[data-data-editor]"));
    expect(data(element).querySelector("[data-data-editor] [data-data-close]")).not.toBeNull();
    const css = [...data(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/@container \(max-width: 899px\) \{ \.sheet-close-btn \{ display: inline-flex; \} \}/);
    // The base rule that hides it comes before the container rule that shows it.
    expect(css.indexOf(".sheet-close-btn { display: none; }")).toBeLessThan(css.indexOf("@container (max-width: 899px) { .sheet-close-btn"));
    data(element).querySelector<HTMLButtonElement>("[data-data-close]")!.click();
    await until(() => !data(element).querySelector("[data-data-editor]"));
  });
});
