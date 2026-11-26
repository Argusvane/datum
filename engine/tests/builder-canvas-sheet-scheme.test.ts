// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { extendBinding } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The on-sheet chrome follows the sheet only where the sheet's scheme differs from the builder's:
 * the canvas reads the builder's scheme from the inline --db-color-scheme the
 * shell writes on its host (absent is light) and the sheet's from the scheme the form is drawn in
 * (`canvasColorScheme()`: Datum's dark look, a binding's dark variant, else light), and
 * syncSheetScheme() sets data-sheet-scheme on the renderer only when the two differ. jsdom
 * applies no CSS, so the attribute is what is asserted.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

/** A design system with no dark look: it draws light under a dark builder. */
const LIGHT_ONLY = extendBinding(createDatumBinding(), { id: "light-only", label: "Light only" });

function mount(builderScheme: "dark" | undefined, binding?: typeof LIGHT_ONLY): { canvas: DatumBuilderCanvasElement; renderer: HTMLElement; controller: BuilderController } {
  const root: ComponentNode = { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } } as ComponentNode;
  const controller = new BuilderController({ initialRoot: root, ...(binding ? { binding } : {}) });
  if (builderScheme) {
    controller.setPreviewScheme(builderScheme);
  }
  const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
  if (builderScheme) {
    canvas.style.setProperty("--db-color-scheme", builderScheme);
  }
  canvas.controller = controller;
  document.body.append(canvas);
  return { canvas, controller, renderer: canvas.shadowRoot!.querySelector("[data-preview]") as HTMLElement };
}

describe("data-sheet-scheme on the canvas renderer", () => {
  it("names the light sheet when a dark builder sits over a binding with no dark look", () => {
    expect(mount("dark", LIGHT_ONLY).renderer.getAttribute("data-sheet-scheme")).toBe("light");
  });

  it("is absent when both are light", () => {
    expect(mount(undefined).renderer.hasAttribute("data-sheet-scheme")).toBe(false);
    expect(mount(undefined, LIGHT_ONLY).renderer.hasAttribute("data-sheet-scheme")).toBe(false);
  });

  it("is absent when both are dark: Datum draws its dark look under a dark builder", () => {
    expect(mount("dark").renderer.hasAttribute("data-sheet-scheme")).toBe(false);
  });

  it("follows the builder's scheme when the shell changes it, with no redraw", () => {
    const { canvas, renderer } = mount(undefined, LIGHT_ONLY);
    expect(renderer.hasAttribute("data-sheet-scheme")).toBe(false);
    canvas.style.setProperty("--db-color-scheme", "dark");
    canvas.syncSheetScheme();
    expect(renderer.getAttribute("data-sheet-scheme")).toBe("light");
    canvas.style.removeProperty("--db-color-scheme");
    canvas.syncSheetScheme();
    expect(renderer.hasAttribute("data-sheet-scheme")).toBe(false);
  });

  it("names a dark sheet under the light builder while the form is drawn dark", () => {
    const { canvas, controller, renderer } = mount(undefined);
    controller.setPreviewScheme("dark");
    // The builder's own tokens have not moved yet (the shell writes them after): the sheet is dark, the builder light.
    expect(renderer.getAttribute("data-sheet-scheme")).toBe("dark");
    canvas.style.setProperty("--db-color-scheme", "dark");
    canvas.syncSheetScheme();
    expect(renderer.hasAttribute("data-sheet-scheme")).toBe(false);
  });
});
