// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  DATUM_BUILDER_CANVAS_TAG,
  DATUM_BUILDER_PROPERTIES_TAG,
  defineBuilderPanels,
  type DatumBuilderCanvasElement,
  type DatumBuilderPropertiesElement
} from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { cssClassCapability } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";

/** The fixtures' definitions with a panel that, as the standard one does, edits its CSS classes (which is what brings the Style tab). */
const DEFINITIONS: ComponentDefinition[] = AGENT_BUILDER_DEFINITIONS.map((definition) =>
  definition.type === "panel" ? { ...definition, capabilities: [...(definition.capabilities ?? []), cssClassCapability] } : definition
);

/**
 * The Style tab's panel looks: a panel offers the binding's four looks as one radio group with a
 * Default choice, a text field offers none, and a change writes the draft's cssClass once, taking
 * the group's other looks with it.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

const form = (): ComponentNode =>
  ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name" } },
        { id: "box", type: "panel", configuration: { label: "Applicant", cssClass: "page-class panel-card" }, children: { content: [] } }
      ]
    }
  }) as ComponentNode;

const settle = async (renderer: DatumFormRendererElement): Promise<void> => {
  await renderer.painted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function mount(selected: string): Promise<{ controller: BuilderController; panel: DatumBuilderPropertiesElement }> {
  const controller = new BuilderController({ initialRoot: form(), componentDefinitions: DEFINITIONS });
  controller.select(selected);
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
  panel.controller = controller;
  document.body.append(canvas, panel);
  await settle(canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement);
  panel.shadowRoot!.querySelector<HTMLElement>('[data-inspector-tab="style"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { controller, panel };
}

const radios = (panel: DatumBuilderPropertiesElement): HTMLInputElement[] =>
  Array.from(panel.shadowRoot!.querySelectorAll<HTMLInputElement>('[data-style-group="panel-look"] input[type="radio"]'));

describe("the Style tab's panel looks", () => {
  it("draws the four looks and a Default as one radio group, the panel's current look checked", async () => {
    const { panel } = await mount("box");
    const group = panel.shadowRoot!.querySelector('fieldset[data-style-group="panel-look"]')!;
    expect(group.querySelector("legend")?.textContent).toBe("Look");
    expect(radios(panel).map((radio) => radio.dataset.styleOption ?? `clear:${radio.dataset.styleGroupClear}`)).toEqual([
      "clear:panel-look",
      "panel-plain",
      "panel-outlined",
      "panel-shaded",
      "panel-card"
    ]);
    expect(new Set(radios(panel).map((radio) => radio.name)).size).toBe(1);
    expect(radios(panel).filter((radio) => radio.checked).map((radio) => radio.dataset.styleOption)).toEqual(["panel-card"]);
    expect(Array.from(group.querySelectorAll(".style-option-text > span:first-child")).map((label) => label.textContent)).toEqual(["Default", "Plain", "Outlined", "Shaded", "Card"]);
  });

  it("offers no look on a text field", async () => {
    const { panel } = await mount("name");
    expect(panel.shadowRoot!.querySelector("[data-style-group]")).toBeNull();
  });

  it("writes one look per change, keeping the other classes, and Default takes it away", async () => {
    const { controller, panel } = await mount("box");
    const plain = radios(panel).find((radio) => radio.dataset.styleOption === "panel-plain")!;
    plain.checked = true;
    plain.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.draftProperty("box", "cssClass")).toBe("page-class panel-plain");

    const none = radios(panel).find((radio) => radio.dataset.styleGroupClear === "panel-look")!;
    none.checked = true;
    none.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.draftProperty("box", "cssClass")).toBe("page-class");
  });

  it("keeps the radio and its focus across a change, so the arrow keys carry on through the looks", async () => {
    const { controller, panel } = await mount("box");
    const root = panel.shadowRoot!;
    const pick = (name: string): HTMLInputElement => radios(panel).find((radio) => radio.dataset.styleOption === name)!;
    const choose = (radio: HTMLInputElement): void => {
      // What an arrow key does to a radio group: focus moves to the next radio, which checks itself and fires change.
      radio.focus();
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const plain = pick("panel-plain");
    choose(plain);
    expect(controller.draftProperty("box", "cssClass")).toBe("page-class panel-plain");
    // The tab was not repainted: the very input is still there, and still has focus.
    expect(plain.isConnected).toBe(true);
    expect(pick("panel-plain")).toBe(plain);
    expect(root.activeElement).toBe(plain);
    // The CSS classes box and the footer follow in place.
    expect(root.querySelector<HTMLInputElement>('[data-prop="cssClass"]')?.value).toBe("page-class panel-plain");
    expect(root.querySelector('[data-inspector-save]')).not.toBeNull();

    // The next arrow key writes again, from the same place.
    const outlined = pick("panel-outlined");
    choose(outlined);
    expect(controller.draftProperty("box", "cssClass")).toBe("page-class panel-outlined");
    expect(outlined.isConnected).toBe(true);
    expect(root.activeElement).toBe(outlined);
    const none = radios(panel).find((radio) => radio.dataset.styleGroupClear === "panel-look")!;
    choose(none);
    expect(controller.draftProperty("box", "cssClass")).toBe("page-class");
    expect(none.isConnected).toBe(true);
    expect(root.activeElement).toBe(none);
    // One draft, so one Save leaves one undo step however many looks were tried.
    expect(controller.commitDraft("box")).toBe(true);
    controller.undo();
    expect(controller.getProperty("box", "cssClass")).toBe("page-class panel-card");
  });

  it("checks the last look of a hand-written list, the one the form draws", async () => {
    const { controller, panel } = await mount("box");
    controller.setDraftProperty("box", "cssClass", "panel-shaded panel-card");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(radios(panel).filter((radio) => radio.checked).map((radio) => radio.dataset.styleOption)).toEqual(["panel-card"]);
    controller.setDraftProperty("box", "cssClass", "panel-card panel-shaded");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(radios(panel).filter((radio) => radio.checked).map((radio) => radio.dataset.styleOption)).toEqual(["panel-shaded"]);
  });
});
