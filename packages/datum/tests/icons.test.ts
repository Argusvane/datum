import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import "../src/builder.js";
// A fixture icons bundle: registers its set as the page's default on load, the way a
// page loads an icon package's bundle before the builder script.
import "./fixtures/acme-icons-bundle.js";
import {
  ICON_FALLBACK_CLASS,
  defaultIconSet,
  markupIconSet,
  svgIconSet,
  type DatumFormBuilderElement
} from "../src/builder.js";
import { ACME_ICONS } from "./fixtures/acme-icons.js";

import { sampleDefinition, until } from "./helpers.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  return element;
}

async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

const panel = (element: DatumFormBuilderElement, tag: string): ShadowRoot =>
  element.builder!.shadowRoot!.querySelector(tag)!.shadowRoot!;

describe("icon sets on <datum-form-builder>", () => {
  it("draws with the page's default set once an icons bundle has registered it, before the elements upgrade", async () => {
    expect(defaultIconSet()).toBe(ACME_ICONS);
    const element = mount();
    await ready(element);
    const palette = panel(element, "datum-builder-toolbar").querySelector('[data-add-type="text"] svg.palette-icon')!;
    expect(palette).toBeTruthy();
    expect(palette.querySelector('path[fill="currentColor"][data-acme-icon]')).toBeTruthy();
    expect(palette.classList.contains(ICON_FALLBACK_CLASS)).toBe(false);
    // The bar's controls and the activity strip draw from the same set.
    const shell = element.builder!.shadowRoot!;
    expect(shell.querySelector('[data-undo] [data-glyph="undo"] svg path[fill="currentColor"][data-acme-icon]')).toBeTruthy();
    expect(shell.querySelector('[data-panel="components"] svg path[fill="currentColor"][data-acme-icon]')).toBeTruthy();
    expect(shell.querySelector('[data-panel="outline"] svg path[fill="currentColor"][data-acme-icon]')).toBeTruthy();
  });

  it("draws with the set given on the element, falls back per name, and carries the set's css into every shadow root", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    const set = markupIconSet(
      "acme",
      {
        "field-text": ({ size }) => `<i class="acme" style="font-size:${size}px" data-acme="text"></i>`,
        undo: () => `<i class="acme" data-acme="undo"></i>`,
        "components-panel": () => `<i class="acme" data-acme="components"></i>`
      },
      ".acme { font-family: Acme; }"
    );
    const element = mount((el) => {
      el.icons = set;
    });
    await ready(element);
    expect(element.icons).toBe(set);
    // The sample form has components, so the palette starts shut and unpainted: open it.
    element.builder!.panel = "components";

    const toolbar = panel(element, "datum-builder-toolbar");
    expect(toolbar.querySelector('[data-add-type="text"] i[data-acme="text"]')).toBeTruthy();
    // A name the set leaves out: the engine's own drawing, marked as the fallback it is.
    expect(toolbar.querySelector(`[data-add-type="select"] svg.palette-icon.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect(toolbar.querySelector("style")!.textContent).toContain("font-family: Acme");

    const shell = element.builder!.shadowRoot!;
    expect(shell.querySelector('[data-undo] i[data-acme="undo"]')).toBeTruthy();
    expect(shell.querySelector(`[data-redo] svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect(shell.querySelector('[data-panel="components"] i[data-acme="components"]')).toBeTruthy();
    expect(shell.querySelector(`[data-panel="outline"] svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect(shell.querySelector("style[data-icon-css]")!.textContent).toContain("font-family: Acme");
    const canvas = panel(element, "datum-builder-canvas");
    expect(canvas.querySelector("style[data-icon-css]")!.textContent).toContain("font-family: Acme");

    // The drag grips are drawn inside the preview renderer, so the css reaches its shadow root too.
    const renderer = canvas.querySelector("datum-form-renderer")!.shadowRoot!;
    await until(() => renderer.querySelector(".db-handle"));
    expect(renderer.querySelector(`.db-handle svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect([...renderer.querySelectorAll("style")].some((style) => style.textContent?.includes("font-family: Acme"))).toBe(true);
  });

  it("repaints the glyphs in place when the set changes after the builder has drawn, and again when cleared", async () => {
    const element = mount();
    await ready(element);
    // The palette starts shut on a form with components; a shut panel is not repainted.
    element.builder!.panel = "components";
    const shell = element.builder!.shadowRoot!;
    const undo = shell.querySelector("[data-undo]")!;
    const outline = shell.querySelector('[data-panel="outline"]')!;
    const before = undo.innerHTML;

    element.icons = svgIconSet("late", {
      undo: { viewBox: "0 0 1 1", body: "<!--late-undo-->" },
      "outline-panel": { viewBox: "0 0 1 1", body: "<!--late-outline-->" },
      "properties-panel": { viewBox: "0 0 1 1", body: "<!--late-props-->" },
      "field-text": { viewBox: "0 0 1 1", body: "<!--late-text-->" }
    });
    expect(undo.innerHTML).toContain("<!--late-undo-->");
    expect(undo.innerHTML).not.toBe(before);
    expect(outline.innerHTML).toContain("<!--late-outline-->");
    expect(panel(element, "datum-builder-toolbar").querySelector('[data-add-type="text"]')!.innerHTML).toContain("<!--late-text-->");
    // The collapsed properties panel's reopen stub draws its glyph from the set too.
    const properties = shell.querySelector("datum-builder-properties") as HTMLElement & { collapsed: boolean };
    properties.collapsed = true;
    expect(properties.shadowRoot!.querySelector("[data-panel-toggle]")!.innerHTML).toContain("<!--late-props-->");

    element.icons = undefined;
    expect(undo.innerHTML).toBe(before);
    expect(outline.innerHTML).not.toContain("<!--late-outline-->");
    expect(properties.shadowRoot!.querySelector('[data-panel-toggle] svg path[fill="currentColor"][data-acme-icon]')).toBeTruthy();
  });
});
