// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A canvas used on its own, the way a host arranges it: its controller cleared and set again
 * (one document closed, another opened).
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

const tree = (): ComponentNode =>
  ({
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "name", type: "text", configuration: { label: "Full name" } }] }
  }) as ComponentNode;

function mount(controller: BuilderController): { canvas: DatumBuilderCanvasElement; root: ShadowRoot } {
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  canvas.controller = controller;
  document.body.append(canvas);
  return { canvas, root: canvas.shadowRoot! };
}

describe("a canvas whose controller is cleared and set again", () => {
  it("keeps a previewed button's action and a language pick on the new renderer", () => {
    const first = new BuilderController({ initialRoot: tree() });
    const { canvas, root } = mount(first);
    const firstRenderer = root.querySelector("[data-preview]");
    canvas.controller = undefined;
    const second = new BuilderController({ initialRoot: tree() });
    canvas.controller = second;
    const renderer = root.querySelector("[data-preview]")!;
    expect(renderer).not.toBe(firstRenderer);

    // The canvas stops a design-time action: it never reaches the host page.
    const reached = vi.fn();
    document.addEventListener("datum-form-action", reached);
    renderer.dispatchEvent(new CustomEvent("datum-form-action", { bubbles: true, composed: true, detail: { action: "submit" } }));
    document.removeEventListener("datum-form-action", reached);
    expect(reached).not.toHaveBeenCalled();

    // A pick in the form's own language switcher is the toolbar's locale choice.
    const setOptions = vi.spyOn(second, "setOptions");
    renderer.dispatchEvent(new CustomEvent("datum-locale-applied", { bubbles: true, composed: true, detail: { locale: "fr" } }));
    expect(setOptions).toHaveBeenCalledWith({ locale: "fr" });
  });
});
