// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/*
 * The Logic editor's working copy against the stored form: a clean copy follows what an undo
 * puts back, Try it answers as the form stores them, and the surface's own prompt goes with the
 * copy. The surface is driven through the real builder element, with the formula box left as its
 * textarea.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "x", type: "text", configuration: { label: "X" }, rules: { visibleWhen: 'a = "1"' } },
        { id: "y", type: "text", configuration: { label: "Y" } },
        {
          id: "v",
          type: "text",
          configuration: { label: "V", messages: { rule: "Old" } },
          rules: { validWhen: 'v != "bad"' }
        },
        {
          id: "rating",
          type: "radio",
          configuration: { label: "Rating", options: [{ value: "1", label: "One" }, { value: "2", label: "Two" }] }
        },
        { id: "r", type: "text", configuration: { label: "R" }, rules: { visibleWhen: 'rating = "2"' } },
        { id: "zip", type: "text", configuration: { label: "Zip" } },
        { id: "z", type: "text", configuration: { label: "Z" }, rules: { visibleWhen: 'zip = "02134"' } },
        { id: "age", type: "number", configuration: { label: "Age" } },
        { id: "w", type: "text", configuration: { label: "W" }, rules: { visibleWhen: "age > 17" } }
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

interface LogicSurface extends HTMLElement {
  controller: BuilderController | undefined;
  readonly dirty: boolean;
  formulaEditorLoader: () => Promise<never>;
  discardPending(): void;
}

async function mountInLogic(): Promise<{ element: DatumBuilderElement; surface: LogicSurface; ctrl: BuilderController }> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = {
    initialRoot: formRoot(),
    componentTypes: [
      { type: "text", label: "Text" },
      { type: "radio", label: "Radio" },
      { type: "number", label: "Number" }
    ]
  };
  element.setAttribute("features", "minimal logic");
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("datum-builder-logic") || element.shadowRoot?.querySelector("[data-tests-panel-item], .canvas"));
  element.setWorkspace("logic");
  await until(() => element.shadowRoot?.querySelector("datum-builder-logic")?.shadowRoot?.querySelector("[data-logic-rule]"));
  const surface = element.shadowRoot!.querySelector("datum-builder-logic") as LogicSurface;
  // The box stays the textarea: the CodeMirror chunk never lands.
  surface.formulaEditorLoader = () => new Promise<never>(() => undefined);
  return { element, surface, ctrl: surface.controller! };
}

const inside = (surface: LogicSurface): ShadowRoot => surface.shadowRoot!;
const editorKind = (surface: LogicSurface): string | null | undefined => inside(surface).querySelector("[data-logic-editor]")?.getAttribute("data-logic-kind");
const box = (surface: LogicSurface): HTMLTextAreaElement => inside(surface).querySelector<HTMLTextAreaElement>("[data-logic-formula-slot] textarea")!;
const prompt = (surface: LogicSurface): HTMLDialogElement | null => inside(surface).querySelector<HTMLDialogElement>("dialog[data-prompt]");

function node(ctrl: BuilderController, id: string): ComponentNode {
  const content = ctrl.snapshot().children?.content ?? [];
  return content.find((child) => child.id === id)!;
}

function openCard(surface: LogicSurface, ruleId: string): void {
  inside(surface).querySelector<HTMLButtonElement>(`[data-logic-rule="${ruleId}"]`)!.click();
}

function type(surface: LogicSurface, text: string): void {
  const textarea = box(surface);
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function apply(surface: LogicSurface): void {
  inside(surface).querySelector<HTMLButtonElement>("[data-logic-apply]")!.click();
}

function newRule(surface: LogicSurface, kind: string): void {
  inside(surface).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
  inside(surface).querySelector<HTMLButtonElement>(`[data-logic-new-kind="${kind}"]`)!.click();
}

function chooseTarget(surface: LogicSurface, componentId: string): void {
  const select = inside(surface).querySelector<HTMLSelectElement>("[data-logic-target]")!;
  select.value = componentId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function tryAnswer(surface: LogicSurface, componentId: string, value: string): string {
  const field = inside(surface).querySelector<HTMLInputElement | HTMLSelectElement>(`[data-logic-try="${componentId}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  return inside(surface).querySelector("[data-logic-try-result]")!.textContent ?? "";
}

describe("a clean copy follows the stored rule", () => {
  it("takes the kind an undo puts back, so Apply keeps the Show the list shows", async () => {
    const { surface, ctrl } = await mountInLogic();
    ctrl.setProperties([{ componentId: "x", propertyPath: "visibleWhen", value: 'not(a = "1")', target: "rules" }]);
    openCard(surface, "form:x:visibleWhen");
    expect(editorKind(surface)).toBe("hide");
    ctrl.undo();
    expect(node(ctrl, "x").rules?.visibleWhen).toBe('a = "1"');
    expect(editorKind(surface)).toBe("show");
    expect(surface.dirty).toBe(false);
    type(surface, 'a = "2"');
    apply(surface);
    expect(node(ctrl, "x").rules?.visibleWhen).toBe('a = "2"');
  });

  it("unticks On paper when an undo takes print.show away, so the next Apply does not write it again", async () => {
    const { surface, ctrl } = await mountInLogic();
    openCard(surface, "form:x:visibleWhen");
    const paper = inside(surface).querySelector<HTMLInputElement>("[data-logic-paper]")!;
    paper.checked = true;
    paper.dispatchEvent(new Event("change", { bubbles: true }));
    apply(surface);
    expect((node(ctrl, "x").configuration as Record<string, unknown>).print).toMatchObject({ show: "always" });
    ctrl.undo();
    expect((node(ctrl, "x").configuration as Record<string, unknown>).print).toBeUndefined();
    expect(inside(surface).querySelector<HTMLInputElement>("[data-logic-paper]")!.checked).toBe(false);
    expect(surface.dirty).toBe(false);
    type(surface, 'a = "2"');
    apply(surface);
    expect(node(ctrl, "x").rules?.visibleWhen).toBe('a = "2"');
    expect((node(ctrl, "x").configuration as Record<string, unknown>).print).toBeUndefined();
  });

  it("shows a check's words an undo puts back", async () => {
    const { surface, ctrl } = await mountInLogic();
    openCard(surface, "form:v:validWhen");
    const message = inside(surface).querySelector<HTMLInputElement>("[data-logic-message]")!;
    message.value = "New";
    message.dispatchEvent(new Event("input", { bubbles: true }));
    apply(surface);
    expect((node(ctrl, "v").configuration as { messages: { rule: string } }).messages.rule).toBe("New");
    ctrl.undo();
    expect((node(ctrl, "v").configuration as { messages: { rule: string } }).messages.rule).toBe("Old");
    expect(inside(surface).querySelector<HTMLInputElement>("[data-logic-message]")!.value).toBe("Old");
    expect(surface.dirty).toBe(false);
  });
});

describe("Try it", () => {
  it("keeps a choice's digit value as the text the form stores", async () => {
    const { surface } = await mountInLogic();
    openCard(surface, "form:r:visibleWhen");
    expect(tryAnswer(surface, "rating", "2")).toContain("R is shown");
  });

  it("keeps digits typed for a text field as text", async () => {
    const { surface } = await mountInLogic();
    openCard(surface, "form:z:visibleWhen");
    expect(tryAnswer(surface, "zip", "02134")).toContain("Z is shown");
  });

  it("still reads digits typed for a number field as a number", async () => {
    const { surface } = await mountInLogic();
    openCard(surface, "form:w:visibleWhen");
    expect(tryAnswer(surface, "age", "18")).toContain("W is shown");
    expect(tryAnswer(surface, "age", "9")).toContain("W is hidden");
  });
});

describe("the surface's own switch prompt", () => {
  async function heldSwitch(): Promise<LogicSurface> {
    const { surface } = await mountInLogic();
    openCard(surface, "form:x:visibleWhen");
    type(surface, 'a = "2"');
    openCard(surface, "form:z:visibleWhen");
    expect(prompt(surface)).not.toBeNull();
    return surface;
  }

  it("goes with the copy discardPending drops", async () => {
    const surface = await heldSwitch();
    surface.discardPending();
    expect(inside(surface).querySelector("[data-logic-editor]")).toBeNull();
    expect(prompt(surface)).toBeNull();
  });

  it("goes with the copy a new controller drops", async () => {
    const surface = await heldSwitch();
    const ctrl = surface.controller;
    surface.controller = undefined;
    surface.controller = ctrl;
    expect(inside(surface).querySelector("[data-logic-editor]")).toBeNull();
    expect(prompt(surface)).toBeNull();
  });
});
