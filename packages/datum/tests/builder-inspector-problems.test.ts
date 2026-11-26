import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { BuilderController, type BuilderProblem, type ComponentDefinition, type ComponentNode, type DatumBuilderElement, type FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * What holds a Save back, shown where the author can act on it: each problem under its own
 * box, marked invalid and described by the message; Save usable and leading to the first one;
 * a count beside Unsaved leading to each; and one component's problem never holding another
 * panel's Save back.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(definition: FormDefinition = sampleDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;

async function formPanel(element: DatumFormBuilderElement): Promise<ShadowRoot> {
  const item = shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="form"]')!;
  if (element.builder!.panel !== "form") {
    item.click();
  }
  await until(() => shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!.querySelector("[data-inspector-save]"));
  return shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
}

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

describe("problems in the inspector", () => {
  // A Pattern that repeats a repeat is not run unless the host allows it; the box says so.
  it("shows a risky Pattern under its box, leaves a safe one alone, and still lets Save save", async () => {
    const element = await mount();
    await select(element, "email");
    const box = (): HTMLInputElement => inspector(element).querySelector<HTMLInputElement>('[data-prop="pattern"]')!;
    type(box(), "(a+)+$");
    await until(() => inspector(element).querySelector("#problem-pattern"));
    const message = inspector(element).querySelector<HTMLElement>("#problem-pattern")!;
    expect(message.textContent).toContain("repeats a repeat");
    expect(message.textContent).toContain("(a+)+$");
    expect(message.closest(".property-row")).toBe(box().closest(".property-row"));
    expect(inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.disabled).toBe(false);
    type(box(), "[a-z]+");
    await until(() => !inspector(element).querySelector("#problem-pattern"));
  });

  it("shows an unusable id under the id box, counts it beside Unsaved, and leads Save to it instead of refusing silently", async () => {
    const element = await mount();
    await select(element, "email");
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "country");
    await until(() => inspector(element).querySelector("#problem-id"));

    const box = inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!;
    const message = inspector(element).querySelector<HTMLElement>("#problem-id")!;
    expect(message.textContent).toBe('ID "country" already exists.');
    // Under the box it is about, in the same row, and tied to it for a screen reader.
    expect(message.closest(".property-row")).toBe(box.closest(".property-row"));
    expect(box.getAttribute("aria-invalid")).toBe("true");
    // The ID's own note first (its "?"), then the problem.
    expect(box.getAttribute("aria-describedby")).toBe("prop-id-help problem-id");
    // Not repeated after every section any more.
    expect(inspector(element).querySelector(".inspector-body .drop-error")).toBeNull();

    // The line above Save says what is wrong.
    const summary = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-problems]")!;
    expect(summary.textContent).toBe('1 problem: ID "country" already exists.');
    const save = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!;
    expect(save.disabled).toBe(false);

    // Save saves nothing: it takes the author to the problem and says why.
    save.focus();
    save.click();
    expect(element.builder!.controller.snapshot().children!.content!.map((node) => node.id)).toContain("email");
    expect(element.builder!.controller.hasPendingChanges("email")).toBe(true);
    expect(inspector(element).activeElement).toBe(inspector(element).querySelector('input[data-prop="id"]'));
    expect(inspector(element).querySelector("[data-inspector-status]")!.textContent).toBe(
      'Not saved: 1 problem. ID "country" already exists.'
    );

    // Fixed, the count goes and Save saves.
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "contactEmail");
    await until(() => !inspector(element).querySelector("[data-inspector-problems]"));
    expect(inspector(element).querySelector("#problem-id")).toBeNull();
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => element.builder!.controller.snapshot().children!.content!.some((node) => node.id === "contactEmail"));
  });

  it("lists several problems from the count, and takes the author to each — opening its section and clearing a filter that hides it", async () => {
    const element = await mount();
    await select(element, "email");
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "country");
    await until(() => inspector(element).querySelector("#problem-id"));
    // The class box is on the Style tab; the ID's problem still counts from there.
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="style"]')!.click();
    await until(() => inspector(element).querySelector('input[data-prop="cssClass"]'));
    expect(inspector(element).querySelector('input[data-prop="id"]')).toBeNull();
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="cssClass"]')!, "2cols");
    await until(() => inspector(element).querySelector("#problem-cssClass"));
    expect(inspector(element).querySelector('input[data-prop="cssClass"]')!.getAttribute("aria-invalid")).toBe("true");

    // Fold the section the class is in, and filter the rows down to one that is not it.
    element.builder!.controller.select("email");
    const presentation = inspector(element).querySelector<HTMLDetailsElement>('details[data-inspector-section="presentation"]')!;
    presentation.open = false;
    presentation.dispatchEvent(new Event("toggle"));
    const filter = inspector(element).querySelector<HTMLInputElement>("[data-property-filter]")!;
    type(filter, "label");
    expect(inspector(element).querySelector<HTMLElement>('input[data-prop="cssClass"]')!.closest<HTMLElement>(".property-row")!.hidden).toBe(true);

    const count = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-problems]")!;
    expect(count.textContent).toBe("2 problems");
    expect(count.getAttribute("aria-expanded")).toBe("false");
    count.click();
    await until(() => inspector(element).querySelector("[data-inspector-problem-list]"));
    const items = [...inspector(element).querySelectorAll<HTMLButtonElement>("[data-problem-go]")];
    expect(items.map((item) => [item.dataset.problemGo, item.textContent])).toEqual([
      ["id", 'ID "country" already exists.'],
      ["cssClass", 'CSS classes "2cols" is not a valid class name.']
    ]);
    expect(inspector(element).querySelector("[data-inspector-problems]")!.getAttribute("aria-expanded")).toBe("true");
    expect(inspector(element).activeElement).toBe(items[0]);

    items[1]!.click();
    const cssBox = inspector(element).querySelector<HTMLInputElement>('input[data-prop="cssClass"]')!;
    expect(inspector(element).activeElement).toBe(cssBox);
    expect(cssBox.closest<HTMLDetailsElement>("details")!.open).toBe(true);
    expect(cssBox.closest<HTMLElement>(".property-row")!.hidden).toBe(false);
    expect(inspector(element).querySelector<HTMLInputElement>("[data-property-filter]")!.value).toBe("");
    // The list closes once a problem is reached.
    expect(inspector(element).querySelector("[data-inspector-problem-list]")).toBeNull();

    // A problem on the other tab takes the author back to Field.
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-problems]")!.click();
    await until(() => inspector(element).querySelector('[data-problem-go="id"]'));
    inspector(element).querySelector<HTMLButtonElement>('[data-problem-go="id"]')!.click();
    expect(inspector(element).querySelector('[data-inspector-tab="properties"]')!.getAttribute("aria-selected")).toBe("true");
    expect(inspector(element).activeElement).toBe(inspector(element).querySelector('input[data-prop="id"]'));
  });

  it("goes to an expression that does not parse too, since Save would quietly keep the last one that did", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content!.push({ id: "notes", type: "text", configuration: { label: "Notes" }, rules: { visibleWhen: { kind: "path", path: "subscribe" } } });
    const element = await mount(definition);
    await select(element, "notes");
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!, "Your notes");
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => inspector(element).querySelector('[data-rule="visibleWhen"][data-rule-formula]'));
    const box = inspector(element).querySelector<HTMLTextAreaElement>('[data-rule="visibleWhen"][data-rule-formula]')!;
    expect(box.value).toBe("subscribe");
    box.focus();
    box.value = "subscribe +";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => inspector(element).querySelector("#problem-rules-visibleWhen"));
    expect(inspector(element).querySelector("#problem-rules-visibleWhen")!.textContent).toMatch(/value/);
    // Back on the Properties tab, Save leads to the Rules tab and the box that does not parse:
    // the plain textarea, or the formula editor mounted over it once its chunk landed.
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!.click();
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => inspector(element).querySelector('[data-inspector-tab="rules"].active'));
    const host = inspector(element).querySelector<HTMLElement>('[data-rule-formula-host="visibleWhen"]')!;
    expect(host.contains(inspector(element).activeElement)).toBe(true);
    expect(inspector(element).activeElement!.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector<HTMLTextAreaElement>("[data-rule-formula]")!.value).toBe("subscribe +");
    expect(element.builder!.controller.getProperty("notes", "label")).toBe("Notes");
  });

  it("never holds the Form panel's Save back for a field's problem", async () => {
    const element = await mount();
    const form = await formPanel(element);
    await select(element, "email");
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "country");
    await until(() => inspector(element).querySelector("#problem-id"));

    const title = form.querySelector<HTMLInputElement>('input[data-prop="title"]')!;
    type(title, "Sample form");
    await until(() => !shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!.querySelector<HTMLButtonElement>("[data-inspector-save]")!.disabled);
    const panel = shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    expect(panel.querySelector("[data-inspector-problems]")).toBeNull();
    expect(panel.textContent).not.toContain("already exists");
    panel.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => (element.builder!.controller.snapshot().configuration as { title?: string }).title === "Sample form");
    // The field's problem is still the field's.
    expect(inspector(element).querySelector("[data-inspector-problems]")!.textContent).toBe('1 problem: ID "country" already exists.');
  });

  it("lists the problem in the unsaved-changes prompt, and Keep editing goes to it", async () => {
    const element = await mount();
    await select(element, "email");
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "country");
    await until(() => inspector(element).querySelector("#problem-id"));
    // Clicking away holds the selection behind the prompt.
    element.builder!.controller.requestSelect("fullName");
    await until(() => inspector(element).querySelector("[data-unsaved-prompt]"));
    const prompt = inspector(element).querySelector<HTMLElement>("[data-unsaved-prompt]")!;
    expect(prompt.querySelector(".db-confirm-problems")!.textContent).toContain('ID "country" already exists.');
    expect(prompt.querySelector<HTMLButtonElement>("[data-unsaved-save]")!.disabled).toBe(true);
    prompt.querySelector<HTMLButtonElement>("[data-unsaved-stay]")!.click();
    await until(() => !inspector(element).querySelector("[data-unsaved-prompt]"));
    expect(element.builder!.controller.selectedComponentId()).toBe("email");
    expect(inspector(element).activeElement).toBe(inspector(element).querySelector('input[data-prop="id"]'));
  });

  it("sends the Header & footer panel's Save to the Form panel when the form's own draft has a problem", async () => {
    const definition = sampleDefinition();
    // A class the renderer would drop, carried in by an imported definition.
    definition.root.configuration = { ...(definition.root.configuration as Record<string, unknown>), cssClass: "2cols" };
    const element = await mount(definition);
    const chromeItem = shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="chrome"]')!;
    chromeItem.click();
    const chrome = (): ShadowRoot => shell(element).querySelector("datum-builder-chrome-panel")!.shadowRoot!;
    await until(() => chrome().querySelector("[data-chrome-problems]"));
    expect(chrome().querySelector("[data-chrome-problems]")!.textContent).toBe("1 problem");
    chrome().querySelector<HTMLButtonElement>("[data-chrome-problems]")!.click();
    expect(element.builder!.panel).toBe("form");
    const form = shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    await until(() => form.querySelector("[data-inspector-status]")?.textContent);
    expect(form.querySelector("[data-inspector-status]")!.textContent).toContain("is not a valid class name");
    expect(form.querySelector("[data-inspector-problems]")!.textContent).toContain("1 problem:");
  });
});

/**
 * A builder mode's own checks (`BuilderControllerOptions.problems`): a journey page's
 * id another page already has. Drawn and led to like the controller's own, held on the
 * unsaved-changes prompt's Save too, and never holding up an edit to anything else.
 */
describe("a formula box typed into", () => {
  // CodeMirror (the editor over the box) reads selection geometry jsdom does not draw.
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

  /** Counts the paints of a panel: `render` is what `paint()` calls once it decides to draw. */
  function countPaints(panel: Element): { count: number; restore: () => void } {
    const proto = Object.getPrototypeOf(panel) as { render(): void };
    const original = proto.render;
    const counter = {
      count: 0,
      restore: () => {
        proto.render = original;
      }
    };
    proto.render = function (this: unknown) {
      counter.count += 1;
      return original.call(this);
    };
    return counter;
  }

  async function openRulesTab(element: DatumFormBuilderElement, key: string): Promise<HTMLTextAreaElement> {
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => inspector(element).querySelector(`[data-rule="${key}"][data-rule-formula]`));
    // Let the lazy pieces (the editor's chunk, the sentence model) land before counting paints.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return inspector(element).querySelector<HTMLTextAreaElement>(`[data-rule="${key}"][data-rule-formula]`)!;
  }

  function keystroke(box: HTMLTextAreaElement, text: string): void {
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  it("writes every keystroke to the draft as typed without a paint of the inspector or the canvas, and refreshes the summary line in place", async () => {
    const element = await mount();
    await select(element, "email");
    const box = await openRulesTab(element, "visibleWhen");
    expect(box.value).toBe("subscribe");
    const controller = element.builder!.controller;
    const propertiesEl = shell(element).querySelector("datum-builder-properties")!;
    const canvasEl = shell(element).querySelector("datum-builder-canvas")!;
    const host = inspector(element).querySelector<HTMLElement>('[data-rule-formula-host="visibleWhen"]')!;
    const editorHost = inspector(element).querySelector<HTMLElement>('[data-rule-formula-editor="visibleWhen"]');
    const feedback = inspector(element).querySelector<HTMLElement>('[data-rule-feedback="visibleWhen"]')!;
    const inspectorPaints = countPaints(propertiesEl);
    const canvasPaints = countPaints(canvasEl);
    try {
      box.focus();
      // Parses (an unknown field), parses, does not parse: the draft equals the box after each.
      for (const text of ["subscribe = tru", "subscribe = true", "subscribe = true +"]) {
        keystroke(box, text);
        expect(controller.draftRules("email")?.visibleWhen).toBe(text);
        expect(inspectorPaints.count).toBe(0);
        expect(canvasPaints.count).toBe(0);
        expect(inspector(element).querySelector('[data-rule-formula-host="visibleWhen"]')).toBe(host);
        expect(inspector(element).querySelector('[data-rule="visibleWhen"][data-rule-formula]')).toBe(box);
        expect(inspector(element).querySelector('[data-rule-formula-editor="visibleWhen"]')).toBe(editorHost);
        expect(inspector(element).querySelector('[data-rule-feedback="visibleWhen"]')).toBe(feedback);
      }
      // The problem is under the box, in the summary above Save (the same words), and the controller's.
      const line = inspector(element).querySelector<HTMLElement>('[data-problem="rules:visibleWhen"]')!;
      expect(line.textContent).toMatch(/value/);
      expect(box.getAttribute("aria-invalid")).toBe("true");
      expect(box.getAttribute("aria-describedby")).toBe("problem-rules-visibleWhen");
      const summary = inspector(element).querySelector<HTMLButtonElement>("[data-inspector-problems]")!;
      expect(summary.textContent).toBe(`1 problem: Rules · Visible when ${line.textContent}`);
      expect(controller.problemsOf("email")).toEqual([{ target: "rules:visibleWhen", message: line.textContent }]);
      expect(inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.disabled).toBe(false);
      // Any caller's commit sees it: nothing is stored, the draft stays (the refusal is a plain
      // change, which the canvas draws; the inspector's state is as it drew it).
      expect(controller.commitDraft("email")).toBe(false);
      expect(controller.snapshot().children!.content!.find((node) => node.id === "email")!.rules).toEqual({ visibleWhen: { kind: "path", path: "subscribe" } });
      expect(controller.draftRules("email")?.visibleWhen).toBe("subscribe = true +");
      expect(canvasPaints.count).toBe(1);
      expect(inspectorPaints.count).toBe(0);
      // Typed on past the problem: the line and the summary go, still without a paint.
      keystroke(box, "subscribe = true + 1");
      expect(inspectorPaints.count).toBe(0);
      expect(inspector(element).querySelector('[data-problem="rules:visibleWhen"]')).toBeNull();
      expect(inspector(element).querySelector("[data-inspector-problems]")).toBeNull();
      expect(box.getAttribute("aria-invalid")).toBeNull();
      expect(controller.problemsOf("email")).toEqual([]);
      // Leaving the box: one plain change, which the canvas draws and the inspector has drawn already.
      box.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
      expect(canvasPaints.count).toBe(2);
      expect(inspectorPaints.count).toBe(0);
      // Nothing more is owed: leaving again writes nothing.
      box.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
      expect(canvasPaints.count).toBe(2);
      expect(controller.draftRules("email")?.visibleWhen).toBe("subscribe = true + 1");
    } finally {
      inspectorPaints.restore();
      canvasPaints.restore();
    }
  });

  it("keeps a tree-stored rule a tree when typed into and typed back, and carries a run scope as the tree, or the string, it stores", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content!.push({ id: "notes", type: "text", configuration: { label: "Notes" }, rules: { visibleWhen: "subscribe" } });
    const element = await mount(definition);
    const controller = element.builder!.controller;
    await select(element, "email");
    const box = await openRulesTab(element, "visibleWhen");
    box.focus();
    keystroke(box, "subscribex");
    expect(controller.draftRules("email")?.visibleWhen).toBe("subscribex");
    keystroke(box, "subscribe");
    expect(controller.draftRules("email")?.visibleWhen).toEqual({ kind: "path", path: "subscribe" });
    expect(controller.hasPendingChanges("email")).toBe(false);
    // A run scope over the untouched tree carries the tree.
    inspector(element).querySelector<HTMLButtonElement>('[data-rule="visibleWhen"][data-rule-run="server"]')!.click();
    expect(controller.draftRules("email")?.visibleWhen).toEqual({ expression: { kind: "path", path: "subscribe" }, run: "server" });
    inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => !controller.hasPendingChanges("email"));
    expect(controller.snapshot().children!.content!.find((node) => node.id === "email")!.rules).toEqual({ visibleWhen: { expression: { kind: "path", path: "subscribe" }, run: "server" } });
    // Over a stored string, the string.
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="properties"]')!.click();
    await select(element, "notes");
    await openRulesTab(element, "visibleWhen");
    inspector(element).querySelector<HTMLButtonElement>('[data-rule="visibleWhen"][data-rule-run="server"]')!.click();
    expect(controller.draftRules("notes")?.visibleWhen).toEqual({ formula: "subscribe", run: "server" });
  });
});

describe("a mode's own problems in the inspector", () => {
  const page = (id: string, pageId: string): ComponentNode => ({ id, type: "page", configuration: { pageId }, children: {} });
  const definitions: ComponentDefinition[] = [
    {
      type: "pages",
      version: "1.0.0",
      createDefault: () => ({ id: "pages", type: "pages", configuration: {}, children: { pages: [] } }),
      capabilities: [],
      children: { slots: [{ id: "pages", multiple: true, allowedTypes: ["page"] }] },
      propertyEditor: { mode: "replace", fields: [] }
    },
    {
      type: "page",
      version: "1.0.0",
      createDefault: () => ({ id: "page", type: "page", configuration: {} }),
      capabilities: [],
      propertyEditor: {
        mode: "replace",
        fields: [
          { id: "pageId", type: "text", propertyPath: "pageId", label: "Page id" },
          { id: "title", type: "text", propertyPath: "title", label: "Title" }
        ]
      }
    }
  ];
  const duplicate = (edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderProblem[] => {
    const pageId = (edited.configuration as { pageId?: string }).pageId;
    const clash = (tree.children?.pages ?? []).some((other) => other.id !== componentId && (other.configuration as { pageId?: string }).pageId === pageId);
    return edited.type === "page" && clash ? [{ target: "pageId", message: `Another page is already called "${pageId}".` }] : [];
  };

  async function mountPages(): Promise<{ element: DatumBuilderElement; controller: BuilderController; inspector: () => ShadowRoot }> {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: { id: "root", type: "form", configuration: { title: "Sample" }, children: { content: [] } } };
    document.body.append(element);
    await until(() => element.shadowRoot?.querySelector("datum-builder-properties"));
    const controller = new BuilderController({
      initialRoot: { id: "pages", type: "pages", configuration: {}, children: { pages: [page("p1", "about"), page("p2", "details"), page("p3", "done"), page("p4", "done")] } },
      componentDefinitions: definitions,
      problems: duplicate,
      // The ids are bookkeeping: no ID row.
      idRow: () => ({ mode: "hidden" })
    });
    element.addMode({ id: "pages", label: "Pages", controller });
    element.setMode("pages");
    await until(() => element.mode === "pages");
    return { element, controller, inspector: () => element.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot! };
  }

  it("shows it under its box, leads Save there, and saves once it is fixed", async () => {
    const { controller, inspector } = await mountPages();
    controller.select("p2");
    await until(() => inspector().querySelector('input[data-prop="pageId"]'));
    expect(inspector().querySelector('input[data-prop="id"]')).toBeNull();
    type(inspector().querySelector<HTMLInputElement>('input[data-prop="pageId"]')!, "about");
    await until(() => inspector().querySelector("#problem-pageId"));
    const box = inspector().querySelector<HTMLInputElement>('input[data-prop="pageId"]')!;
    expect(inspector().querySelector("#problem-pageId")!.textContent).toBe('Another page is already called "about".');
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(inspector().querySelector("[data-inspector-problems]")!.textContent).toBe('1 problem: Page id Another page is already called "about".');

    inspector().querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(controller.getProperty("p2", "pageId")).toBe("details");
    expect(inspector().activeElement).toBe(inspector().querySelector('input[data-prop="pageId"]'));

    // The unsaved-changes prompt cannot save past it either.
    expect(controller.requestSelect("p1")).toBe(false);
    await until(() => inspector().querySelector("[data-unsaved-prompt]"));
    expect(inspector().querySelector<HTMLButtonElement>("[data-unsaved-save]")!.disabled).toBe(true);
    controller.answerUnsavedChangesPrompt("save");
    expect(controller.selectedComponentId()).toBe("p2");
    expect(controller.getProperty("p2", "pageId")).toBe("details");
    controller.answerUnsavedChangesPrompt("stay");

    type(inspector().querySelector<HTMLInputElement>('input[data-prop="pageId"]')!, "contact");
    await until(() => !inspector().querySelector("#problem-pageId"));
    inspector().querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => controller.getProperty("p2", "pageId") === "contact");
  });

  it("never holds up an edit to anything else on a page whose id already clashed", async () => {
    const { controller, inspector } = await mountPages();
    controller.select("p4");
    await until(() => inspector().querySelector('input[data-prop="title"]'));
    type(inspector().querySelector<HTMLInputElement>('input[data-prop="title"]')!, "All done");
    expect(inspector().querySelector("[data-inspector-problems]")).toBeNull();
    inspector().querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => controller.getProperty("p4", "title") === "All done");
    expect(controller.getProperty("p4", "pageId")).toBe("done");
  });
});

