import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/** The inspector's Field / Style / Logic tabs, its head and the JSON behind its ⋯. */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const tabs = (element: DatumFormBuilderElement): Array<[string | undefined, string | null, string | null]> =>
  [...inspector(element).querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => [tab.dataset.inspectorTab, tab.textContent, tab.getAttribute("aria-selected")]);

async function mountOn(id: string): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-properties"));
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector("[data-inspector-title]"));
  return element;
}

describe("inspector tabs", () => {
  it("names the component and its type over Field, Style and Logic, counting its rules", async () => {
    const element = await mountOn("email");
    const title = inspector(element).querySelector<HTMLElement>("[data-inspector-title]")!;
    expect(title.querySelector("strong")!.textContent).toBe("Email");
    expect(title.querySelector("span")!.textContent).not.toBe("");
    expect(tabs(element)).toEqual([
      ["properties", "Field", "true"],
      ["style", "Style", "false"],
      ["rules", "Logic 1", "false"]
    ]);
    expect(inspector(element).querySelector('[data-inspector-tab="rules"]')!.getAttribute("aria-label")).toBe("Logic, 1 rule");
    expect(inspector(element).querySelector('[role="tablist"]')).not.toBeNull();
  });

  it("keeps presentation on Style and the rest, On paper last, on Field, with Saves to on Field", async () => {
    const element = await mountOn("fullName");
    expect(inspector(element).querySelector('details[data-inspector-section="presentation"]')).toBeNull();
    expect(inspector(element).querySelector('details[data-inspector-section="content"]')).not.toBeNull();
    // How it prints from the live form closes the Field tab.
    const sections = [...inspector(element).querySelectorAll("details[data-inspector-section]")];
    expect(sections[sections.length - 1]!.getAttribute("data-inspector-section")).toBe("print");
    expect(sections[sections.length - 1]!.querySelector('select[data-prop="print.show"]')).not.toBeNull();
    expect(inspector(element).querySelector<HTMLInputElement>("[data-saved-as] input")!.value).toBe("fullName");
    // A read-only box like the ID's, named by its label and described by its ? note: readonly,
    // not disabled, so the path can still be selected and copied.
    const savesTo = inspector(element).querySelector<HTMLInputElement>("[data-saved-as] input")!;
    expect(savesTo.readOnly).toBe(true);
    expect(savesTo.disabled).toBe(false);
    expect(savesTo.type).toBe("text");
    expect(savesTo.dataset.prop).toBeUndefined();
    expect(inspector(element).querySelector(`label[for="${savesTo.id}"]`)!.textContent).toBe("Saves to");
    expect(savesTo.getAttribute("aria-describedby")).toBe("prop-savedAs-help");
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="style"]')!.click();
    await until(() => inspector(element).querySelector('details[data-inspector-section="presentation"]'));
    expect(inspector(element).querySelector('details[data-inspector-section="content"]')).toBeNull();
    expect(inspector(element).querySelector("[data-saved-as]")).toBeNull();
    expect(inspector(element).querySelector('details[data-inspector-section="print"]')).toBeNull();
    expect((element.builder!.shadowRoot!.querySelector("datum-builder-properties") as HTMLElement & { inspectorTab: string }).inspectorTab).toBe("style");
  });

  it("floats in the drawer as cards: the head, the identity rows, then a card per section", async () => {
    const element = await mountOn("fullName");
    const drawer = shell(element).querySelector<HTMLElement>(".body > datum-builder-properties")!;
    expect(drawer.hasAttribute("data-floating")).toBe(true);
    // The Form panel is the same element in the side column, and keeps its plain look.
    for (const other of shell(element).querySelectorAll<HTMLElement>(".side datum-builder-properties")) {
      expect(other.hasAttribute("data-floating")).toBe(false);
    }
    const root = drawer.shadowRoot!;
    const top = root.querySelector(".panel > .inspector-top")!;
    expect(top.querySelector("[data-inspector-title]")).not.toBeNull();
    expect(top.querySelector('[role="tablist"]')).not.toBeNull();
    expect(top.querySelector("[data-property-filter]")).not.toBeNull();
    const about = root.querySelector(".inspector-body > [data-inspector-about]")!;
    expect(about.querySelector("#prop-id")).not.toBeNull();
    expect(about.querySelector("[data-saved-as]")).not.toBeNull();
    expect(root.querySelector("[data-translation-pointer]")).not.toBeNull();
    expect(root.querySelector('.inspector-body > details[data-inspector-section="content"]')).not.toBeNull();
    // Apply and Discard stay outside the scrolling body, a card of their own.
    expect(root.querySelector(".panel > .inspector-footer [data-inspector-save]")).not.toBeNull();
  });

  it("shows the component's JSON from the ⋯ menu, which Escape closes", async () => {
    const element = await mountOn("fullName");
    const more = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-more]")!;
    const menu = (): HTMLElement => inspector(element).querySelector<HTMLElement>("[data-inspector-menu]")!;
    expect(menu().hidden).toBe(true);
    more.click();
    expect(menu().hidden).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(inspector(element).activeElement).toBe(menu().querySelector('[role="menuitem"]'));
    menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(menu().hidden).toBe(true);
    expect(inspector(element).activeElement).toBe(more);

    more.click();
    menu().querySelector<HTMLButtonElement>('[data-inspector-tab="json"]')!.click();
    await until(() => inspector(element).querySelector("[data-json-view]"));
    expect(inspector(element).querySelector("[data-inspector-more]")!.classList.contains("active")).toBe(true);
    expect(menu().hidden).toBe(true);
  });

  it("commits with Apply and Discard, and says what is not applied", async () => {
    const element = await mountOn("fullName");
    const save = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!;
    expect(save.textContent).toBe("Apply");
    expect(inspector(element).querySelector("[data-inspector-cancel]")!.textContent).toBe("Discard");
    const label = inspector(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    label.value = "Name";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => inspector(element).querySelector("[data-not-applied]"));
    expect(inspector(element).querySelector("[data-not-applied]")!.textContent).toBe("Not applied");
  });

  it("writes the reverted value into the same live box on Discard, though the markup is unchanged", async () => {
    const element = await mountOn("fullName");
    const label = inspector(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    const before = label.value;
    label.value = "Typed but discarded";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => inspector(element).querySelector("[data-not-applied]"));
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.click();
    const after = inspector(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    expect(after).toBe(label);
    expect(after.value).toBe(before);
  });
});

/** The JSON behind the ⋯ is a box to edit, drafted like any other edit. */
describe("the Logic tab's Reads as line", () => {
  /** The rule's box on the Logic tab, the rule switched to Formula first when it was Off. */
  async function ruleBox(element: DatumFormBuilderElement, key: string): Promise<HTMLTextAreaElement> {
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => inspector(element).querySelector(`[data-rule="${key}"][data-rule-mode="formula"]`));
    if (!inspector(element).querySelector(`[data-rule="${key}"][data-rule-formula]`)) {
      inspector(element).querySelector<HTMLButtonElement>(`[data-rule="${key}"][data-rule-mode="formula"]`)!.click();
      await until(() => inspector(element).querySelector(`[data-rule="${key}"][data-rule-formula]`));
    }
    return inspector(element).querySelector<HTMLTextAreaElement>(`[data-rule="${key}"][data-rule-formula]`)!;
  }

  async function readsAs(element: DatumFormBuilderElement, key: string, formula: string): Promise<string> {
    const box = await ruleBox(element, key);
    box.value = formula;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // The sentence model is a lazy chunk; until it lands the line is the printed formula.
    await until(() => {
      const words = lineWords(element, key);
      return words !== undefined && !words.split(" ").includes("if");
    });
    return lineWords(element, key)!;
  }

  /** The Reads as line's tokens after its label, spaced; `undefined` while there is no line. */
  function lineWords(element: DatumFormBuilderElement, key: string): string | undefined {
    const line = inspector(element).querySelector<HTMLElement>(`[data-rule-feedback="${key}"] [data-rule-reads]`);
    if (!line) {
      return undefined;
    }
    return [...line.querySelectorAll("span")]
      .slice(1)
      .map((span) => span.textContent)
      .join(" ");
  }

  it("words a value rule's cases as the Logic workspace does, and a condition as its sentence", async () => {
    const element = await mountOn("fullName");
    // An `if` reads as its cases, the way the Logic list words "Start Full name at …", without that lead.
    expect(await readsAs(element, "defaultValue", 'if subscribe then "yes" else "no"')).toBe("yes when Subscribe is ticked , otherwise no");
    element.builder!.controller.discardDraft("fullName");
    // A condition is the Logic list's sentence for it.
    expect(await readsAs(element, "visibleWhen", "subscribe and country = \"CA\"")).toBe("Subscribe is ticked and Country is CA");
  });

  it("keeps the printed formula with labels for a value rule that is a bare expression", async () => {
    const element = await mountOn("fullName");
    const box = await ruleBox(element, "defaultValue");
    box.value = "upper(country)";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => inspector(element).querySelector('[data-rule-feedback="defaultValue"] [data-rule-reads]'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(lineWords(element, "defaultValue")).toBe("upper( Country )");
  });
});

describe("inspector JSON editing", () => {
  // jsdom lays nothing out. CodeMirror measures text through a Range's rects once it has a
  // caret to scroll to, and takes jsdom for Safari, placing a shadow root's selection with
  // execCommand: both are stubbed while these tests focus the editor, and put back after.
  const restore: Array<() => void> = [];
  beforeEach(() => {
    const range = Range.prototype as unknown as Record<string, unknown>;
    for (const name of ["getClientRects", "getBoundingClientRect"]) {
      if (typeof range[name] !== "function") {
        range[name] = name === "getClientRects" ? () => [] : () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
        restore.push(() => delete range[name]);
      }
    }
    const doc = document as unknown as Record<string, unknown>;
    if (typeof doc.execCommand !== "function") {
      doc.execCommand = () => false;
      restore.push(() => delete doc.execCommand);
    }
  });
  afterEach(() => {
    for (const undo of restore.splice(0)) {
      undo();
    }
  });
  const controller = (element: DatumFormBuilderElement) => element.builder!.controller;
  /** The box as the markup has it: the textarea the editor mounts over, which edits the same way. */
  const box = (root: ShadowRoot): HTMLTextAreaElement => root.querySelector<HTMLTextAreaElement>("textarea[data-json-edit]")!;
  const typeJson = (root: ShadowRoot, text: string): void => {
    const target = box(root);
    target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  };
  const committedLabel = (element: DatumFormBuilderElement): unknown =>
    (controller(element).snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as Record<string, unknown>).label;

  async function openJson(root: ShadowRoot): Promise<void> {
    root.querySelector<HTMLButtonElement>("[data-inspector-more]")!.click();
    const item = root.querySelector<HTMLButtonElement>('[data-inspector-menu] [data-inspector-tab="json"]')!;
    expect(item.textContent).toBe("Edit JSON");
    item.click();
    await until(() => root.querySelector("textarea[data-json-edit]"));
  }

  it("shows the component's id, type, configuration and rules, and names the box", async () => {
    const element = await mountOn("email");
    await openJson(inspector(element));
    const shown = JSON.parse(box(inspector(element)).value) as Record<string, unknown>;
    expect(Object.keys(shown)).toEqual(["id", "type", "configuration", "rules"]);
    expect(shown).toMatchObject({
      id: "email",
      type: "text",
      configuration: { label: "Email" },
      rules: { visibleWhen: { kind: "path", path: "subscribe" } }
    });
    expect(box(inspector(element)).getAttribute("aria-label")).toBe("The component's JSON");
    // The editor takes the box's place once its chunk loads, under the same name.
    await until(() => inspector(element).querySelector(".json-editor .cm-content"));
    expect(inspector(element).querySelector(".json-editor .cm-content")!.getAttribute("aria-label")).toBe("The component's JSON");
    expect(box(inspector(element)).hidden).toBe(true);
  });

  it("drafts what the JSON changes, shows it on Field, and Apply commits it as one undo step", async () => {
    const element = await mountOn("fullName");
    const root = inspector(element);
    await openJson(root);
    const json = JSON.parse(box(root).value) as { configuration: Record<string, unknown> };
    json.configuration.label = "Your name";
    json.configuration.placeholder = "First Last";
    typeJson(root, JSON.stringify(json, null, 2));
    expect((controller(element).editedNode("fullName")!.configuration as Record<string, unknown>).label).toBe("Your name");
    expect(controller(element).draftProperty("fullName", "placeholder")).toBe("First Last");
    expect(controller(element).hasPendingChanges("fullName")).toBe(true);
    expect(committedLabel(element)).toBe("Full name");
    // The box keeps the text as typed.
    expect(box(root).value).toBe(JSON.stringify(json, null, 2));

    root.querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!.click();
    await until(() => root.querySelector<HTMLInputElement>('input[data-prop="label"]'));
    expect(root.querySelector<HTMLInputElement>('input[data-prop="label"]')!.value).toBe("Your name");

    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(committedLabel(element)).toBe("Your name");
    expect(controller(element).hasPendingChanges("fullName")).toBe(false);
    controller(element).undo();
    expect(committedLabel(element)).toBe("Full name");
  });

  it("says where JSON that does not parse goes wrong, keeps the last good draft, and Apply leads to it instead of applying", async () => {
    const element = await mountOn("fullName");
    const root = inspector(element);
    await openJson(root);
    const json = JSON.parse(box(root).value) as { configuration: Record<string, unknown> };
    json.configuration.label = "Your name";
    const good = JSON.stringify(json, null, 2);
    typeJson(root, good);
    // A comma short after the id's line.
    const broken = good.replace('"fullName",', '"fullName"');
    typeJson(root, broken);
    await until(() => root.querySelector('[data-problem="json"]'));
    expect(root.querySelector('[data-problem="json"]')!.textContent).toMatch(/^Line 3, column 3: Expected a comma or }\.$/);
    expect(box(root).value).toBe(broken);
    expect(box(root).getAttribute("aria-invalid")).toBe("true");
    expect(box(root).getAttribute("aria-describedby")).toBe("problem-json");
    // The draft keeps the last text that applied.
    expect((controller(element).editedNode("fullName")!.configuration as Record<string, unknown>).label).toBe("Your name");
    // Apply is never disabled: it says what is wrong and goes to it, and commits nothing.
    const save = root.querySelector<HTMLButtonElement>("[data-inspector-save]")!;
    expect(save.disabled).toBe(false);
    expect(root.querySelector("[data-inspector-problems]")!.textContent).toContain("JSON");
    root.querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!.click();
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(committedLabel(element)).toBe("Full name");
    expect(root.querySelector<HTMLElement>("[data-inspector-status]")!.textContent).toMatch(/^Not saved: 1 problem\. JSON/);
    expect(root.querySelector("[data-inspector-more]")!.classList.contains("active")).toBe(true);
    expect(box(root).value).toBe(broken);
  });

  it("keeps the same editor across the repaints its edits cause, the text and the problem on it", async () => {
    const element = await mountOn("subscribe");
    const root = inspector(element);
    await openJson(root);
    await until(() => root.querySelector(".json-editor .cm-editor"));
    const editor = root.querySelector(".json-editor .cm-editor")!;
    const content = (): HTMLElement => root.querySelector<HTMLElement>(".json-editor .cm-content")!;
    content().focus();
    // Typing in the editor: CodeMirror reads the change from its DOM, as it does a keystroke.
    const text = [...content().querySelectorAll(".cm-line")].flatMap((line) => [...line.childNodes]).find((node) => node.textContent?.includes('"Subscribe"'));
    const leaf = text?.nodeType === Node.TEXT_NODE ? text : [...(text?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Subscribe"));
    (leaf as Text).data = (leaf as Text).data.replace("Subscribe", "Subscribed");
    await until(() => controller(element).draftProperty("subscribe", "label") === "Subscribed");
    // The panel repainted around it; the editor is the same one, put back.
    expect(root.querySelector(".json-editor .cm-editor")).toBe(editor);
    expect(editor.isConnected).toBe(true);
    expect(root.activeElement).toBe(content());
    expect(box(root).value).toContain('"Subscribed"');
    typeJson(root, "{");
    await until(() => content().getAttribute("aria-invalid") === "true");
    expect(content().getAttribute("aria-describedby")).toBe("problem-json");
    expect(root.querySelector(".json-editor .cm-editor")).toBe(editor);
    expect(content().textContent).toBe("{");
  });

  it("refuses a type change and children under the box, drafting nothing", async () => {
    const element = await mountOn("fullName");
    const root = inspector(element);
    await openJson(root);
    const json = JSON.parse(box(root).value) as Record<string, unknown>;
    typeJson(root, JSON.stringify({ ...json, type: "checkbox" }, null, 2));
    await until(() => root.querySelector('[data-problem="json"]'));
    expect(root.querySelector('[data-problem="json"]')!.textContent).toContain("The type cannot change");
    typeJson(root, JSON.stringify({ ...json, children: { content: [] } }, null, 2));
    await until(() => root.querySelector('[data-problem="json"]')?.textContent?.includes("children are edited on the canvas"));
    expect(controller(element).hasPendingChanges("fullName")).toBe(false);
  });

  it("applies a whole node pasted from elsewhere, its id included", async () => {
    const element = await mountOn("subscribe");
    const root = inspector(element);
    await openJson(root);
    typeJson(root, JSON.stringify({ id: "newsletter", type: "checkbox", configuration: { label: "Send me the newsletter" } }));
    expect(controller(element).draftId("subscribe")).toBe("newsletter");
    expect(controller(element).draftProperty("subscribe", "label")).toBe("Send me the newsletter");
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(controller(element).snapshot().children!.content!.some((node) => node.id === "newsletter")).toBe(true);
  });

  it("Discard puts the draft and the box back as they were", async () => {
    const element = await mountOn("fullName");
    const root = inspector(element);
    await openJson(root);
    const original = box(root).value;
    const json = JSON.parse(original) as { configuration: Record<string, unknown> };
    json.configuration.label = "Your name";
    typeJson(root, JSON.stringify(json));
    typeJson(root, "{ not json");
    await until(() => root.querySelector('[data-problem="json"]'));
    root.querySelector<HTMLButtonElement>("[data-inspector-cancel]")!.click();
    expect(controller(element).hasPendingChanges("fullName")).toBe(false);
    await until(() => box(root).value === original);
    expect(root.querySelector('[data-problem="json"]')).toBeNull();
  });

  it("follows a draft changed elsewhere: the Field tab's edit shows in the box", async () => {
    const element = await mountOn("subscribe");
    const root = inspector(element);
    await openJson(root);
    controller(element).setDraftProperty("subscribe", "label", "Keep me posted");
    await until(() => (JSON.parse(box(root).value) as { configuration: { label: string } }).configuration.label === "Keep me posted");
  });

  it("edits the form's own settings from the Form panel, leaving its children to the canvas", async () => {
    const element = await mountOn("fullName");
    const item = shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="form"]')!;
    if (element.builder!.panel !== "form") {
      item.click();
    }
    const form = (): ShadowRoot => shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    await until(() => form().querySelector("[data-inspector-save]"));
    await openJson(form());
    const shown = JSON.parse(box(form()).value) as Record<string, unknown>;
    expect(shown).toMatchObject({ id: "root", type: "form", configuration: { title: "Sample" } });
    expect(shown.children).toBeUndefined();
    expect(form().querySelector("[data-json-note]")!.textContent).toBe("Children are edited on the canvas.");
    const renamed = { ...shown, configuration: { ...(shown.configuration as object), title: "Renamed" } };
    typeJson(form(), JSON.stringify(renamed));
    expect(controller(element).draftProperty("root", "title")).toBe("Renamed");
    // The root's id stays: the form's id is its identity's, not this node's to change.
    typeJson(form(), JSON.stringify({ ...renamed, id: "other" }));
    await until(() => form().querySelector('[data-problem="json"]')?.textContent?.includes("The ID cannot change here"));
    expect(controller(element).draftId("root")).toBe("root");
  });
});
