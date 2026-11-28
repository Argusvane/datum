// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_PROPERTIES_TAG, defineBuilderPanels, type DatumBuilderPropertiesElement } from "../form-engine/builder/web-component/builder-panels.js";
import { PDF_DOCUMENT_BODY_SLOT, PDF_TEXT_COMPONENT_TYPE } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createEmptyPdfDocumentRoot, pdfComponentDefinitions } from "../form-engine/render/pdf/pdf-components.js";

/**
 * What the properties panel keeps of its own beside the draft: the text an expression box holds
 * as typed and its parse failure. It goes with the draft on Discard and Escape, and with the
 * stored value on Undo and Redo, so the box never shows what the draft no longer holds.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

function pdfLayout(): ComponentNode {
  const root = createEmptyPdfDocumentRoot();
  return {
    ...root,
    children: {
      ...root.children,
      [PDF_DOCUMENT_BODY_SLOT]: [
        { id: "t1", type: PDF_TEXT_COMPONENT_TYPE, configuration: { text: "Hello", variant: "body" } },
        { id: "t2", type: PDF_TEXT_COMPONENT_TYPE, configuration: { text: "Later", variant: "body" } }
      ]
    }
  };
}

function mount(): { controller: BuilderController; panel: DatumBuilderPropertiesElement; root: ShadowRoot } {
  const controller = new BuilderController({ initialRoot: pdfLayout(), componentDefinitions: pdfComponentDefinitions() });
  const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
  panel.controller = controller;
  document.body.append(panel);
  controller.select("t1");
  return { controller, panel, root: panel.shadowRoot! };
}

const expressionBox = (root: ShadowRoot): HTMLTextAreaElement => root.querySelector<HTMLTextAreaElement>('textarea[data-prop="expression"]')!;

function type(root: ShadowRoot, text: string): void {
  const box = expressionBox(root);
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** The text component's committed expression. */
function stored(controller: BuilderController): unknown {
  const body = controller.snapshot().children?.[PDF_DOCUMENT_BODY_SLOT] ?? [];
  return (body.find((node) => node.id === "t1")?.configuration as Record<string, unknown> | undefined)?.expression;
}

const footer = (root: ShadowRoot): string => root.querySelector(".inspector-footer")?.textContent ?? "";

describe("an expression box's working text", () => {
  it("goes with the draft on Discard, and takes no problem with it", () => {
    const { controller, root } = mount();
    type(root, '{"kind":"path","path":"x"}');
    expect(controller.draftProperty("t1", "expression")).toEqual({ kind: "path", path: "x" });
    type(root, "{ nope");
    expect(footer(root)).toContain("problem");

    root.querySelector<HTMLElement>("[data-inspector-cancel]")!.click();
    expect(controller.hasPendingChanges("t1")).toBe(false);
    expect(expressionBox(root).value).toBe("");
    expect(footer(root)).not.toContain("problem");

    // The next edit applies.
    type(root, '{"kind":"path","path":"y"}');
    root.querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(controller.hasPendingChanges("t1")).toBe(false);
    expect(stored(controller)).toEqual({ kind: "path", path: "y" });
  });

  it("goes with the draft on Escape", () => {
    const { controller, root } = mount();
    type(root, '{"kind":"path","path":"x"}');
    type(root, "{ nope");
    // Escape in a box of several lines is not Discard; on the panel's other controls it is.
    root.querySelector<HTMLElement>("[data-inspector-cancel]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(controller.hasPendingChanges("t1")).toBe(false);
    expect(expressionBox(root).value).toBe("");
    expect(footer(root)).not.toContain("problem");
  });

  it("follows the stored value on Undo and Redo", () => {
    const { controller, root } = mount();
    type(root, '{"kind":"path","path":"x"}');
    root.querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(stored(controller)).toEqual({ kind: "path", path: "x" });

    controller.undo();
    expect(stored(controller)).toBeUndefined();
    expect(expressionBox(root).value).toBe("");
    controller.redo();
    expect(JSON.parse(expressionBox(root).value)).toEqual({ kind: "path", path: "x" });
  });

  it("stays as typed through an Undo of another component's edit", () => {
    const { controller, root } = mount();
    controller.setProperty("t2", "text", "Bye");
    type(root, "{ nope");
    controller.undo();
    expect(expressionBox(root).value).toBe("{ nope");
  });
});
