import { describe, expect, it } from "vitest";

import {
  PROPERTIES_STYLES,
  inspectorFooterHtml,
  optionsEditorHtml,
  propertiesPanelHtml,
  type PropertiesPanelOptions
} from "../form-engine/builder/web-component/builder-shared.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import type { InspectorField, InspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

describe("messages dialog row names", () => {
  const view = {
    kind: "messages" as const,
    path: "messages",
    title: "Messages",
    rows: [
      { value: "required", label: "", seeded: true },
      { value: "", label: "" }
    ],
    newValue: "",
    newLabel: "",
    error: undefined,
    sourceId: undefined,
    maximized: false
  };

  it("names a seeded row by its code, not 'Message of message 1'", () => {
    const html = optionsEditorHtml(view);
    expect(html).toContain('aria-label="required message"');
    expect(html).not.toContain("Message of message 1");
  });

  it("falls back to the positional name for a row with no code yet", () => {
    expect(optionsEditorHtml(view)).toContain('aria-label="Message of message 2"');
  });
});

describe("inspector parts follow the builder's features", () => {
  const root: ComponentNode = { id: "root", type: "form", configuration: {} };
  const field = (propertyPath: string, value: string): InspectorField => ({
    propertyPath,
    label: propertyPath,
    description: undefined,
    control: "text",
    value,
    choices: []
  });
  const rootModel: InspectorModel = {
    mode: "default",
    nodeId: "root",
    nodeType: "form",
    sections: [
      { id: "settings", title: "Settings", fields: [field("title", "t")] }
    ]
  };
  const base = (node: ComponentNode): PropertiesPanelOptions => ({
    tab: "properties",
    treeView: buildNestedTreeView(node),
    hiddenIds: new Set<string>(),
    idError: undefined,
    idEditable: false,
    isRoot: true,
    formulaSettings: { value: "warn" }
  });

  it("shows the Formulas section when its part is on and omits it when off", () => {
    const on = propertiesPanelHtml(rootModel, root, base(root));
    for (const id of ["formulas", "settings"]) {
      expect(on).toContain(`data-inspector-section="${id}"`);
    }
    // The Form panel has no Localization section: languages are Languages'.
    expect(on).not.toContain('data-inspector-section="localization"');
    // Nor a Print section: the form's print settings are the Print workspace's, a component's own are "On paper".
    expect(on).not.toContain('data-inspector-section="print"');
    const off = propertiesPanelHtml(rootModel, root, { ...base(root), parts: { formulas: false } });
    expect(off).not.toContain('data-inspector-section="formulas"');
    expect(off).toContain('data-inspector-section="settings"');
  });

  it("draws a component's On paper section while the print part is on and drops it when the part is off", () => {
    const text: ComponentNode = { id: "t", type: "text", configuration: {} };
    const model: InspectorModel = {
      mode: "default",
      nodeId: "t",
      nodeType: "text",
      sections: [{ id: "print", title: "On paper", fields: [field("print.show", "x")] }]
    };
    const html = propertiesPanelHtml(model, text, { ...base(text), isRoot: false, parts: { formulas: false } });
    expect(html).toContain('data-inspector-section="print"');
    const off = propertiesPanelHtml(model, text, { ...base(text), isRoot: false, parts: { print: false } });
    expect(off).not.toContain('data-inspector-section="print"');
  });

  it("draws a disabled choice as a disabled option", () => {
    const html = propertiesPanelHtml(
      {
        mode: "default",
        nodeId: "t",
        nodeType: "text",
        sections: [
          {
            id: "print",
            title: "On paper",
            fields: [{ ...field("print.on", ""), control: "select", choices: [{ value: "", label: "Both" }, { value: "paper", label: "Paper", disabled: true }] }]
          }
        ]
      },
      { id: "t", type: "text", configuration: {} },
      { ...base({ id: "t", type: "text", configuration: {} }), isRoot: false }
    );
    expect(html).toMatch(/<option value="paper" disabled>Paper<\/option>/);
    expect(html).toMatch(/<option value="" selected>Both<\/option>/);
  });

  const button: ComponentNode = { id: "go", type: "button", configuration: { action: "pdf", signature: "webauthn" } };
  const select = (propertyPath: string, value: string, choices: string[]): InspectorField => ({
    ...field(propertyPath, value),
    control: "select",
    choices: choices.map((choice) => ({ value: choice, label: `L-${choice}` }))
  });
  const buttonModel = (action: string, signature: string): InspectorModel => ({
    mode: "default",
    nodeId: "go",
    nodeType: "button",
    sections: [
      {
        id: "settings",
        title: "Settings",
        fields: [select("action", action, ["submit", "download", "pdf"]), select("signature", signature, ["", "webauthn"])]
      }
    ]
  });
  const buttonOptions = (parts?: PropertiesPanelOptions["parts"]): PropertiesPanelOptions => ({
    ...base(button),
    isRoot: false,
    idEditable: true,
    ...(parts ? { parts } : {})
  });

  it("offers the pdf action and the passkey signature only while their parts are on", () => {
    const on = propertiesPanelHtml(buttonModel("submit", ""), button, buttonOptions());
    expect(on).toContain('<option value="pdf"');
    expect(on).toContain('<option value="webauthn"');
    const off = propertiesPanelHtml(buttonModel("submit", ""), button, buttonOptions({ pdfAction: false, webauthn: false }));
    expect(off).not.toContain('<option value="pdf"');
    expect(off).not.toContain('<option value="webauthn"');
    expect(off).toContain('<option value="download"');
  });

  it("keeps a stored value the choices no longer offer, so a round trip rewrites nothing", () => {
    const html = propertiesPanelHtml(buttonModel("pdf", "webauthn"), button, buttonOptions({ pdfAction: false, webauthn: false }));
    expect(html).toMatch(/<option value="pdf" selected>/);
    expect(html).toMatch(/<option value="webauthn" selected>/);
  });

  it("does not touch a select that is not a button's", () => {
    const text: ComponentNode = { id: "t", type: "text", configuration: {} };
    const model: InspectorModel = { mode: "default", nodeId: "t", nodeType: "text", sections: [{ id: "s", title: "S", fields: [select("action", "pdf", ["pdf"])] }] };
    expect(propertiesPanelHtml(model, text, { ...buttonOptions({ pdfAction: false }) })).toContain('<option value="pdf"');
  });
});

describe("inspector footer order", () => {
  it("puts Delete after Discard and Apply in the markup, so Tab reaches them first", () => {
    const html = inspectorFooterHtml({ hasSelection: true, dirty: true, deletable: true });
    const at = (needle: string): number => html.indexOf(needle);
    expect(at("data-inspector-cancel")).toBeGreaterThan(-1);
    expect(at("data-inspector-save")).toBeGreaterThan(at("data-inspector-cancel"));
    expect(at("data-inspector-delete")).toBeGreaterThan(at("data-inspector-save"));
  });
});

describe("inspector footer visual order", () => {
  it("keeps Delete leading visually while it is last in the DOM", () => {
    expect(PROPERTIES_STYLES).toContain(".inspector-footer-row > [data-inspector-delete] { order: -1; }");
  });
});
