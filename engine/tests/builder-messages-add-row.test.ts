// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_PROPERTIES_TAG, defineBuilderPanels, type DatumBuilderPropertiesElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";

/**
 * The Validation messages editor's add row on Apply, as the options editor treats its own: a
 * code and its message typed there are a row Apply writes, and either one alone is refused
 * with the reason, the dialog left open, rather than dropped without a word.
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
    children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
  }) as ComponentNode;

function openMessages(): { controller: BuilderController; root: ShadowRoot } {
  const controller = new BuilderController({ initialRoot: form(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
  const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
  panel.controller = controller;
  document.body.append(panel);
  controller.select("name");
  const root = panel.shadowRoot!;
  root.querySelector<HTMLElement>("[data-messages-edit]")!.click();
  return { controller, root };
}

function typeAddRow(root: ShadowRoot, code: string, message: string): void {
  for (const [part, text] of [
    ["value", code],
    ["label", message]
  ] as const) {
    const box = root.querySelector<HTMLInputElement>(`[data-options-new="${part}"]`)!;
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }
}

const apply = (root: ShadowRoot): void => root.querySelector<HTMLElement>("[data-options-apply]")!.click();

describe("the messages editor's add row on Apply", () => {
  it("writes a code and message typed there without Add", () => {
    const { controller, root } = openMessages();
    typeAddRow(root, "custom.taken", "That name is taken.");
    apply(root);
    expect(root.querySelector("[data-options-apply]")).toBeNull();
    expect(controller.getProperty("name", "messages")).toEqual({ "custom.taken": "That name is taken." });
  });

  it("refuses a code with no message, and says so", () => {
    const { controller, root } = openMessages();
    typeAddRow(root, "custom.taken", "");
    apply(root);
    expect(root.querySelector("[data-options-apply]")).not.toBeNull();
    expect(root.querySelector(".db-options-error")?.textContent).toBe('The message for "custom.taken" is empty.');
    expect(controller.getProperty("name", "messages")).toBeUndefined();
  });

  it("refuses a message with no code, and says so", () => {
    const { controller, root } = openMessages();
    typeAddRow(root, "", "That name is taken.");
    apply(root);
    expect(root.querySelector("[data-options-apply]")).not.toBeNull();
    expect(root.querySelector(".db-options-error")?.textContent).toContain("Enter the validation code");
    expect(controller.getProperty("name", "messages")).toBeUndefined();
  });
});
