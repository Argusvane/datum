// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { DatumBuilderFormFieldsElement } from "../form-engine/builder/web-component/builder-form-fields-panel.js";
import type { BuilderModeFormFields } from "../form-engine/builder/web-component/builder-modes.js";
import type { DatumBuilderOutlineElement } from "../form-engine/builder/web-component/builder-outline.js";
import type { DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/*
 * A builder moved in the DOM (taken off the page and put back, as a framework re-parenting it
 * does): the reconnect rebuilds the shell's markup, and the new panels and the bar are pointed at
 * the controller on the page as at the first connect.
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
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function mount(): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  document.body.append(element);
  return element;
}

const canvasOf = (element: DatumBuilderElement): DatumBuilderCanvasElement => element.shadowRoot!.querySelector(".canvas") as DatumBuilderCanvasElement;
const outlineOf = (element: DatumBuilderElement): DatumBuilderOutlineElement => element.shadowRoot!.querySelector(".outline") as DatumBuilderOutlineElement;
const fieldsOf = (element: DatumBuilderElement): DatumBuilderFormFieldsElement => element.shadowRoot!.querySelector(".fields") as DatumBuilderFormFieldsElement;
const undoOf = (element: DatumBuilderElement): HTMLButtonElement => element.shadowRoot!.querySelector("[data-undo]") as HTMLButtonElement;

describe("a builder reconnected", () => {
  it("points the rebuilt panels at the controller, and its bar hears the controller again", () => {
    const element = mount();
    const first = canvasOf(element);
    expect(first.controller).toBe(element.controller);
    element.remove();
    document.body.append(element);
    expect(canvasOf(element)).not.toBe(first);
    expect(canvasOf(element).controller).toBe(element.controller);
    expect(outlineOf(element).controller).toBe(element.controller);
    expect(fieldsOf(element).controller).toBe(element.controller);
    expect(undoOf(element).disabled).toBe(true);
    expect(element.controller.requestAddAfter("text")).toBe(true);
    expect(element.controller.canUndo()).toBe(true);
    expect(undoOf(element).disabled).toBe(false);
  });

  it("hands the rebuilt Form fields panel the fields of the mode on the page", async () => {
    const element = mount();
    const fields: BuilderModeFormFields = {
      offered: () => true,
      rows: () => [],
      add: () => false,
      drag: () => undefined,
      subscribe: () => () => undefined
    };
    element.addMode({ id: "steps", label: "Steps", controller: new BuilderController({ initialRoot: formRoot() }), formFields: fields });
    expect(element.setMode("steps")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(element.mode).toBe("steps");
    expect(fieldsOf(element).fields).toBe(fields);
    element.remove();
    document.body.append(element);
    expect(fieldsOf(element).fields).toBe(fields);
    expect(canvasOf(element).controller).toBe(element.activeController);
  });
});
