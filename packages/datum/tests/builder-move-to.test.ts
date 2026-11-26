import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition, JourneyConfiguration } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/**
 * Moving a component to another place: the selection bar's Move to...
 * dialog and the canvas's keyboard move mode. Both list only where a drop could land, cross
 * container and journey-page boundaries, move as one undo step, and say where it went.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** The sample form with a group after Full name: [fullName, address{street}, country, subscribe, email, submit]. */
function withGroup(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.splice(1, 0, {
    id: "address",
    type: "fieldset",
    configuration: { label: "Address" },
    children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }] }
  });
  return definition;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const canvasEl = (element: DatumFormBuilderElement) => shell(element).querySelector("datum-builder-canvas")! as HTMLElement & { previewing: boolean; runAction(action: string): void };
const canvas = (element: DatumFormBuilderElement): ShadowRoot => canvasEl(element).shadowRoot!;
const pane = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>(".canvas-page")!;
const form = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector<HTMLElement>("datum-form-renderer[data-preview]")!.shadowRoot!;
const zone = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>("[data-selection-zone]")!;
const action = (element: DatumFormBuilderElement, id: string): HTMLButtonElement => canvas(element).querySelector<HTMLButtonElement>(`[data-selection-action="${id}"]`)!;
const said = (element: DatumFormBuilderElement): string => canvas(element).querySelector<HTMLElement>("[data-canvas-announce]")!.textContent ?? "";
const childIds = (element: DatumFormBuilderElement, parentId = "root"): string[] => {
  const find = (node: { id: string; children?: Record<string, Array<{ id: string }>> }): { id: string; children?: Record<string, Array<{ id: string }>> } | undefined =>
    node.id === parentId ? node : Object.values(node.children ?? {}).flat().map((child) => find(child as never)).find(Boolean);
  return (find(element.builder!.controller.snapshot() as never)?.children?.content ?? []).map((child) => child.id);
};
const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const marker = (element: DatumFormBuilderElement): HTMLElement | null => form(element).querySelector<HTMLElement>(".db-marker");
const box = (element: DatumFormBuilderElement, id: string): HTMLElement =>
  [...form(element).querySelectorAll<HTMLElement>(".db-node[data-component-id]")].find((node) => node.dataset.componentId === id)!;

/** M on the canvas. The first one on a canvas loads the mover's chunk, so this waits until the canvas has spoken. */
async function startMoving(element: DatumFormBuilderElement): Promise<void> {
  const before = said(element);
  press(pane(element), "m");
  await until(() => said(element) !== before);
}

/** Move to... in the selection bar; the dialog arrives with the chunk. */
async function openMoveDialog(element: DatumFormBuilderElement): Promise<HTMLDialogElement> {
  action(element, "move").click();
  await until(() => canvas(element).querySelector("dialog[data-move-prompt]"));
  return canvas(element).querySelector<HTMLDialogElement>("dialog[data-move-prompt]")!;
}

async function mount(definition: FormDefinition = withGroup()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => form(element)?.querySelector('[data-component-id="fullName"]'));
  await settle();
  return element;
}

async function selected(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => !zone(element).hidden && box(element, id));
  pane(element).focus();
}

describe("the selection bar's Move to...", () => {
  it("sits after Move down, in the bar's one Tab stop, named Move to...", async () => {
    const element = await mount();
    await selected(element, "country");
    const bar = canvas(element).querySelector<HTMLElement>("[data-selection-bar]")!;
    expect([...bar.querySelectorAll<HTMLElement>("[data-selection-action]")].map((button) => button.dataset.selectionAction)).toEqual(["up", "down", "move", "duplicate", "logic", "delete"]);
    expect(action(element, "move").getAttribute("aria-label")).toBe("Move to…");
    expect(action(element, "move").getAttribute("data-tip")).toBe("Move to… (M)");
    expect(action(element, "move").disabled).toBe(false);
  });

  it("lists the legal places and positions, opens on where it is, and moves into a group as one undo step", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await selected(element, "country");
    const dialog = await openMoveDialog(element);
    expect(dialog.querySelector("h4")!.textContent).toBe("Move “Country”");
    const target = dialog.querySelector<HTMLSelectElement>("[data-move-target]")!;
    const position = dialog.querySelector<HTMLSelectElement>("[data-move-position]")!;
    expect([...target.options].map((option) => option.textContent)).toEqual(["Top level (where it is now)", "  Address"]);
    expect([...position.options].map((option) => option.textContent)).toEqual([
      "First",
      "After Full name",
      "After Address",
      "After Subscribe",
      "After Email",
      "Last"
    ]);
    expect(position.value).toBe("2");
    const confirm = dialog.querySelector<HTMLButtonElement>("[data-move-confirm]")!;
    expect(confirm.disabled).toBe(true);

    target.value = "1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...position.options].map((option) => option.textContent)).toEqual(["First", "Last"]);
    expect(position.value).toBe("1");
    expect(confirm.disabled).toBe(false);
    position.value = "0";
    position.dispatchEvent(new Event("change", { bubbles: true }));
    expect(confirm.disabled).toBe(false);

    const undoable = controller.canUndo();
    confirm.click();
    expect(childIds(element)).toEqual(["fullName", "address", "subscribe", "email", "submit"]);
    expect(childIds(element, "address")).toEqual(["country", "street"]);
    expect(controller.selectedComponentId()).toBe("country");
    expect(canvas(element).querySelector("dialog[data-move-prompt]")).toBeNull();
    expect(said(element)).toBe("Moved to Address, position 1 of 2");
    expect(canvas(element).activeElement).toBe(pane(element));

    controller.undo();
    expect(childIds(element)).toEqual(["fullName", "address", "country", "subscribe", "email", "submit"]);
    expect(childIds(element, "address")).toEqual(["street"]);
    expect(controller.canUndo()).toBe(undoable);
  });

  it("closes on Cancel with nothing moved, and runs from the command palette's runAction", async () => {
    const element = await mount();
    await selected(element, "email");
    canvasEl(element).runAction("move");
    await until(() => canvas(element).querySelector("dialog[data-move-prompt]"));
    canvas(element).querySelector<HTMLButtonElement>("[data-move-cancel]")!.click();
    expect(canvas(element).querySelector("dialog[data-move-prompt]")).toBeNull();
    expect(childIds(element)).toEqual(["fullName", "address", "country", "subscribe", "email", "submit"]);
  });

  it("leaves Move up and Move down inside the component's own slot", async () => {
    const element = await mount();
    await selected(element, "street");
    expect(action(element, "up").disabled).toBe(true);
    expect(action(element, "down").disabled).toBe(true);
    expect(action(element, "move").disabled).toBe(false);
    press(pane(element), "ArrowUp", { altKey: true });
    expect(childIds(element, "address")).toEqual(["street"]);
    await selected(element, "country");
    action(element, "up").click();
    expect(childIds(element)).toEqual(["fullName", "country", "address", "subscribe", "email", "submit"]);
  });
});

describe("the keyboard move mode", () => {
  it("starts on M where the component is, walks across into a group, and moves on Enter as one undo step", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await selected(element, "country");
    const undoable = controller.canUndo();

    await startMoving(element);
    expect(said(element)).toBe("Moving Country. Arrow keys choose a place, Enter moves it there, Escape cancels. Top level, position 3 of 6");
    expect(box(element, "country").classList.contains("db-dragging")).toBe(true);
    // The drag's marker, where it is now: before Subscribe.
    expect((marker(element)!.nextElementSibling as HTMLElement).dataset.componentId).toBe("subscribe");
    expect(marker(element)!.parentElement!.hasAttribute("data-db-drag-over")).toBe(true);

    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Top level, position 4 of 6");
    press(pane(element), "ArrowDown");
    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Top level, position 6 of 6");
    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Address, position 1 of 2");
    expect((marker(element)!.nextElementSibling as HTMLElement).dataset.componentId).toBe("street");
    expect(marker(element)!.parentElement!.dataset.parentId).toBe("address");
    // Nothing has moved yet.
    expect(childIds(element, "address")).toEqual(["street"]);

    press(pane(element), "Enter");
    expect(childIds(element, "address")).toEqual(["country", "street"]);
    expect(childIds(element)).toEqual(["fullName", "address", "subscribe", "email", "submit"]);
    expect(said(element)).toBe("Moved to Address, position 1 of 2");
    expect(controller.selectedComponentId()).toBe("country");
    await settle();
    expect(marker(element)).toBeNull();

    controller.undo();
    expect(childIds(element)).toEqual(["fullName", "address", "country", "subscribe", "email", "submit"]);
    expect(controller.canUndo()).toBe(undoable);
  });

  it("goes back with the up arrow, stops at the ends, and Home and End jump", async () => {
    const element = await mount();
    await selected(element, "country");
    await startMoving(element);
    press(pane(element), "End");
    expect(said(element)).toBe("Address, position 2 of 2");
    // At the end the words change, or a live region would stay silent.
    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Address, position 2 of 2. No further places.");
    press(pane(element), "Home");
    expect(said(element)).toBe("Top level, position 1 of 6");
    press(pane(element), "ArrowUp");
    expect(said(element)).toBe("Top level, position 1 of 6. No further places.");
    press(pane(element), "Enter");
    expect(childIds(element)).toEqual(["country", "fullName", "address", "subscribe", "email", "submit"]);
    expect(said(element)).toBe("Moved to Top level, position 1 of 6");
  });

  it("cancels on Escape with nothing changed, and keeps every other key while it is on", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await selected(element, "country");
    await startMoving(element);
    press(pane(element), "ArrowDown");
    // Delete, Alt+arrow and Ctrl+Z do nothing while moving.
    const deleted = press(pane(element), "Delete");
    expect(deleted.defaultPrevented).toBe(true);
    press(pane(element), "ArrowUp", { altKey: true });
    press(pane(element), "z", { ctrlKey: true });
    expect(canvas(element).querySelector("dialog[data-delete-prompt]")).toBeNull();
    expect(childIds(element)).toEqual(["fullName", "address", "country", "subscribe", "email", "submit"]);

    press(pane(element), "Escape");
    expect(said(element)).toBe("Move cancelled.");
    expect(marker(element)).toBeNull();
    expect(box(element, "country").classList.contains("db-dragging")).toBe(false);
    expect(controller.selectedComponentId()).toBe("country");
    expect(controller.canUndo()).toBe(false);
    // Back to the canvas's own keys.
    press(pane(element), "ArrowDown");
    expect(controller.selectedComponentId()).toBe("subscribe");
  });

  it("says Enter on its own place moved nothing, and ends on a change from elsewhere, saying so", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await selected(element, "country");
    await startMoving(element);
    press(pane(element), "Enter");
    expect(said(element)).toBe("Not moved: it is already there.");
    expect(controller.canUndo()).toBe(false);

    // The chunk is in by now: M starts at once.
    press(pane(element), "m");
    expect(marker(element)).not.toBeNull();
    controller.select("email");
    await until(() => marker(element) === null);
    expect(said(element)).toBe("Move cancelled.");
    // The arrows walk the selection again.
    press(pane(element), "ArrowDown");
    expect(controller.selectedComponentId()).toBe("submit");
  });

  it("does nothing on the form itself, and says so for a component with nowhere else to go", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content = [{ id: "only", type: "text", configuration: { label: "Only" } }];
    const element = document.createElement("datum-form-builder");
    element.definition = definition;
    document.body.append(element);
    await until(() => form(element)?.querySelector('[data-component-id="only"]'));
    await settle();
    element.builder!.controller.select("root");
    await settle();
    pane(element).focus();
    press(pane(element), "m");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(said(element)).toBe("");
    expect(marker(element)).toBeNull();

    await selected(element, "only");
    await startMoving(element);
    expect(said(element)).toBe("Only has nowhere else to go.");
    expect(marker(element)).toBeNull();
    // The dialog says the same, its Move off.
    await openMoveDialog(element);
    expect(canvas(element).querySelector("[data-move-nowhere]")!.textContent).toBe("Only has nowhere else to go.");
    expect(canvas(element).querySelector<HTMLButtonElement>("[data-move-confirm]")!.disabled).toBe(true);
  });
});

describe("moving a question between journey pages", () => {
  function journeyBlock(): JourneyConfiguration {
    return JSON.parse(
      JSON.stringify({
        journeys: [
          {
            id: "intake",
            name: "Intake",
            pages: [
              { id: "about", title: "About you", components: ["fullName", "country"] },
              { id: "contact", title: "Keeping in touch", components: ["subscribe"], routes: [{ to: "$end" }] }
            ]
          }
        ],
        defaultJourneyId: "intake",
        opensAs: "journey"
      })
    ) as JourneyConfiguration;
  }

  it("walks to the next page by keyboard, moves there on Enter, and the journey's pages and routes keep their ids", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = { ...sampleDefinition(), journey: journeyBlock() };
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(element);
    element.mode = "journeys";
    const sheet = (): ShadowRoot | undefined => (canvasEl(element) as unknown as { previewRoot(): ShadowRoot | undefined }).previewRoot();
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    // A question is moved from the Step view, where it is drawn as the field it is.
    element.journeyMode!.view = "step";
    await until(() => sheet()?.querySelector("[data-journey-heading]"));
    const controller = element.journeyMode!.controller;
    const pages = controller.snapshot().children!.pages!;
    const pageIds = pages.map((page) => page.id);
    const country = pages[0]!.children!.content![1]!;
    controller.select(country.id);
    await until(() => !zone(element).hidden);
    pane(element).focus();

    await startMoving(element);
    expect(said(element)).toContain("Step 1 · About you, position 2 of 2");
    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Step 2 · Keeping in touch, position 1 of 2");
    press(pane(element), "ArrowDown");
    expect(said(element)).toBe("Step 2 · Keeping in touch, position 2 of 2");
    press(pane(element), "Enter");
    expect(said(element)).toBe("Moved to Step 2 · Keeping in touch, position 2 of 2");

    const after = controller.snapshot().children!.pages!;
    expect(after.map((page) => page.id)).toEqual(pageIds);
    expect(after[1]!.children!.content!.map((node) => node.id)).toContain(country.id);
    await until(() => element.definition.journey?.journeys?.[0]?.pages?.[1]?.components?.length === 2);
    const written = element.definition.journey!.journeys![0]!;
    expect(written.pages.map((page) => [page.id, page.components])).toEqual([
      ["about", ["fullName"]],
      ["contact", ["subscribe", "country"]]
    ]);
    expect(written.pages[1]!.routes).toEqual([{ to: "$end" }]);
  });
});

describe("the keyboard move mode across steps and held moves", () => {
  function withSteps(): FormDefinition {
    const definition = sampleDefinition();
    definition.root.children!.content!.push({
      id: "wizard",
      type: "steps",
      configuration: {},
      children: {
        content: [
          { id: "about", type: "step", configuration: { label: "About" }, children: { content: [{ id: "given", type: "text", configuration: { label: "Given" } }] } },
          { id: "business", type: "step", configuration: { label: "Business" }, children: { content: [{ id: "legal", type: "text", configuration: { label: "Legal" } }] } }
        ]
      }
    });
    return definition;
  }
  const stepPanel = (element: DatumFormBuilderElement, id: string): HTMLElement => form(element).querySelector<HTMLElement>(`[data-step-panel="${id}"]`)!;

  it("puts the component's own step back on Escape after the walk opened another", async () => {
    const element = await mount(withSteps());
    await selected(element, "given");
    expect(stepPanel(element, "about").hidden).toBe(false);
    await startMoving(element);
    for (let i = 0; i < 8 && stepPanel(element, "business").hidden; i += 1) {
      press(pane(element), "ArrowDown");
      await settle();
    }
    expect(stepPanel(element, "business").hidden).toBe(false);
    press(pane(element), "Escape");
    await until(() => stepPanel(element, "business").hidden);
    expect(stepPanel(element, "about").hidden).toBe(false);
    expect(element.builder!.controller.selectedComponentId()).toBe("given");
    expect(element.builder!.controller.canUndo()).toBe(false);
  });

  it("says Moved once a held move runs after the unsaved-edits prompt", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    await selected(element, "country");
    controller.setDraftProperty("country", "configuration.label", "Nation");
    await startMoving(element);
    press(pane(element), "Home");
    press(pane(element), "Enter");
    // Held behind the prompt: nothing has moved, nothing is claimed.
    expect(childIds(element)[0]).toBe("fullName");
    expect(said(element)).not.toMatch(/^Moved/);
    controller.answerUnsavedChangesPrompt("save");
    await until(() => childIds(element)[0] === "country");
    expect(said(element)).toBe("Moved to Top level, position 1 of 6");
  });
});
