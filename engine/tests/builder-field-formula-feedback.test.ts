// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_PROPERTIES_TAG, defineBuilderPanels, type DatumBuilderPropertiesElement } from "../form-engine/builder/web-component/builder-panels.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createEmptyPdfTemplateRoot, pdfTemplateComponentDefinitions } from "../form-engine/render/pdf/pdf-template-components.js";
import { PDF_AREA_COMPONENT_TYPE, PDF_TEMPLATE_AREAS_SLOT } from "../form-engine/render/pdf/pdf-template-constants.js";

/**
 * A formula box on the Field tab (a PDF template area filled from a formula) draws the Rules
 * tab's feedback under it: the "Try one" chips over an empty box, and Retry when the formula
 * editor failed to load. Their clicks work there as on the Rules tab, and a chip puts its formula
 * in the box on either tab.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

function template(): ComponentNode {
  const root = createEmptyPdfTemplateRoot();
  return {
    ...root,
    children: {
      ...root.children,
      [PDF_TEMPLATE_AREAS_SLOT]: [
        { id: "a1", type: PDF_AREA_COMPONENT_TYPE, configuration: { page: 1, rect: { x: 10, y: 10, width: 100, height: 20 }, source: { kind: "expression" } } }
      ]
    }
  };
}

function mount(): { controller: BuilderController; panel: DatumBuilderPropertiesElement; root: ShadowRoot } {
  const controller = new BuilderController({ initialRoot: template(), componentDefinitions: pdfTemplateComponentDefinitions() });
  const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
  // As a PDF layout's workspace sets it: no Rules tab, only the Field tab.
  panel.showRulesTab = false;
  panel.controller = controller;
  document.body.append(panel);
  controller.select("a1");
  return { controller, panel, root: panel.shadowRoot! };
}

describe("a Field-tab formula box's feedback", () => {
  it("puts a Try one chip's formula in the box", () => {
    const { controller, root } = mount();
    const chip = root.querySelector<HTMLElement>('[data-rule="field:source.expression"][data-rule-try]');
    expect(chip).not.toBeNull();
    const example = chip!.dataset.ruleTry!;
    chip!.click();
    expect(controller.draftProperty("a1", "source.expression")).toBe(example);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[data-rule-formula][data-rule="field:source.expression"]')!.value).toBe(example);
  });

  it("asks for the formula editor again on Retry", () => {
    const { panel, root } = mount();
    // As after the editor's chunk failed to load.
    const loading = panel as unknown as { formulaEditorLoad: string; paint(): void };
    loading.formulaEditorLoad = "failed";
    loading.paint();
    const retry = root.querySelector<HTMLElement>('[data-rule="field:source.expression"][data-rule-editor-retry]');
    expect(retry).not.toBeNull();
    retry!.click();
    expect(loading.formulaEditorLoad).not.toBe("failed");
    expect(root.querySelector("[data-rule-editor-retry]")).toBeNull();
  });
});

describe("a Rules-tab formula box's Try one chip", () => {
  it("puts its formula in the box as well as the draft", () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }, { id: "age", type: "number", configuration: { label: "Age" } }] }
      } as ComponentNode
    });
    const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
    panel.controller = controller;
    document.body.append(panel);
    controller.select("name");
    const root = panel.shadowRoot!;
    root.querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
    root.querySelector<HTMLElement>('[data-rule="visibleWhen"][data-rule-mode="formula"]')!.click();
    const chip = root.querySelector<HTMLElement>('[data-rule="visibleWhen"][data-rule-try]')!;
    const example = chip.dataset.ruleTry!;
    chip.click();
    expect(controller.editedNode("name")?.rules?.visibleWhen).toBe(example);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[data-rule-formula][data-rule="visibleWhen"]')!.value).toBe(example);
  });
});
