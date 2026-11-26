import { describe, expect, it } from "vitest";

import {
  BUTTON_ACTION_OPTIONS,
  BUTTON_COMPONENT_TYPE,
  BUTTON_SIGNATURE_OPTIONS,
  isButtonAction,
  readButtonAction,
  readButtonSignature
} from "../form-engine/core/schema/button.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function buttonDefinition(): ComponentDefinition {
  return {
    type: BUTTON_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: BUTTON_COMPONENT_TYPE,
      type: BUTTON_COMPONENT_TYPE,
      configuration: { label: "Submit", action: "submit" }
    }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        {
          id: "action",
          type: "select",
          propertyPath: "action",
          label: "Action",
          choices: BUTTON_ACTION_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label
          }))
        }
      ]
    }
  } as unknown as ComponentDefinition;
}

describe("button action vocabulary", () => {
  it("recognizes known actions and rejects anything else", () => {
    expect(isButtonAction("submit")).toBe(true);
    expect(isButtonAction("download")).toBe(true);
    expect(isButtonAction("pdf")).toBe(true);
    expect(isButtonAction("teleport")).toBe(false);
    expect(isButtonAction(undefined)).toBe(false);
  });

  it("presents submit first: the common case, and what a new button is seeded with", () => {
    expect(BUTTON_ACTION_OPTIONS.map((option) => option.value)).toEqual(["submit", "download", "pdf"]);
  });

  it("reads the signature option, dropping anything but the vocabulary", () => {
    expect(readButtonSignature({ signature: "webauthn" })).toBe("webauthn");
    expect(readButtonSignature({ signature: "" })).toBeUndefined();
    expect(readButtonSignature({ signature: "telepathy" })).toBeUndefined();
    expect(readButtonSignature({})).toBeUndefined();
    expect(BUTTON_SIGNATURE_OPTIONS.map((option) => option.value)).toEqual(["", "webauthn"]);
  });

  it("reads an action off configuration, tolerating an unknown one", () => {
    expect(readButtonAction({ action: "submit" })).toBe("submit");
    // Forward compatibility: a form authored by a newer builder still reports its action,
    // so a host dispatcher — not the reader — decides it is unhandled.
    expect(readButtonAction({ action: "teleport" })).toBe("teleport");
    expect(readButtonAction({})).toBeUndefined();
    expect(readButtonAction(undefined)).toBeUndefined();
  });
});

describe("button in the render model", () => {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        {
          id: "send",
          type: BUTTON_COMPONENT_TYPE,
          configuration: { label: "Send it", action: "submit" }
        },
        { id: "plain", type: BUTTON_COMPONENT_TYPE, configuration: { label: "No action yet" } },
        { id: "passkey", type: BUTTON_COMPONENT_TYPE, configuration: { label: "Sign and submit", action: "submit", signature: "webauthn" } },
        { id: "unsigned", type: BUTTON_COMPONENT_TYPE, configuration: { label: "Plain submit", action: "submit", signature: "" } }
      ]
    }
  };

  it("projects the configured action onto the component model", async () => {
    const output = await buildRenderOutput({
      mode: "interactive",
      root,
      state: new FormStateStore("en").snapshot(),
      resolver
    });

    expect(output.components.find((c) => c.id === "send")?.buttonAction).toBe("submit");
    // A button with no action configured yet still renders; it just has nothing to dispatch.
    expect(output.components.find((c) => c.id === "plain")?.buttonAction).toBeUndefined();
    // The signature option rides along for a submit; the builder's "none" (`""`) reads as unset.
    expect(output.components.find((c) => c.id === "passkey")?.buttonSignature).toBe("webauthn");
    expect(output.components.find((c) => c.id === "unsigned")?.buttonSignature).toBeUndefined();
    expect(output.components.find((c) => c.id === "send")?.buttonSignature).toBeUndefined();
    // Only buttons carry an action.
    expect(output.components.find((c) => c.id === "name")?.buttonAction).toBeUndefined();
  });
});

describe("button in the builder", () => {
  function controller() {
    return new BuilderController({
      componentTypes: [{ type: BUTTON_COMPONENT_TYPE, label: "Button" }],
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } },
      componentDefinitions: [
        {
          type: "form",
          version: "1.0.0",
          createDefault: () => ({ id: "form", type: "form", configuration: {}, children: { content: [] } }),
          capabilities: [],
          children: { slots: [{ id: "content", multiple: true }] }
        } as unknown as ComponentDefinition,
        buttonDefinition()
      ]
    });
  }

  it("seeds a new button from the definition's createDefault, with a generated id", () => {
    const ctrl = controller();
    ctrl.add(BUTTON_COMPONENT_TYPE);

    const node = ctrl.selectedNode();
    expect(node?.type).toBe(BUTTON_COMPONENT_TYPE);
    expect(node?.configuration).toMatchObject({ label: "Submit", action: "submit" });
    // createDefault's own id is a template value; two adds must not collide on it.
    expect(node?.id).not.toBe(BUTTON_COMPONENT_TYPE);
    ctrl.add(BUTTON_COMPONENT_TYPE);
    const ids = ctrl.snapshot().children!.content!.map((child) => child.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the same seeded default for a palette drag payload", () => {
    const payload = controller().dragPayloadForType(BUTTON_COMPONENT_TYPE);
    expect(payload.kind).toBe("template-component");
    if (payload.kind === "template-component") {
      expect(payload.component.configuration).toMatchObject({ action: "submit" });
    }
  });

  it("offers the action vocabulary as inspector choices", () => {
    const node: ComponentNode = {
      id: "send",
      type: BUTTON_COMPONENT_TYPE,
      configuration: { label: "Submit", action: "submit" }
    };
    const model = buildInspectorModel(node, [], buttonDefinition().propertyEditor);

    const fields = model.sections.flatMap((s) => s.fields);
    const action = fields.find((f) => f.propertyPath === "action");
    expect(action?.control).toBe("select");
    expect(action?.value).toBe("submit");
    expect(action?.choices).toEqual([
      { value: "submit", label: "Submit form" },
      { value: "download", label: "Submit and download JSON" },
      { value: "pdf", label: "Download as PDF" }
    ]);
    // A button is not a value field, so `replace` mode drops the default required checkbox.
    expect(fields.map((f) => f.propertyPath)).toEqual(["label", "action"]);
  });

  it("edits the button caption as a translatable string, like every other label", () => {
    // `replace` mode drops the engine's default fields, so a caption declared as plain `text`
    // would be the one user-facing label in the form that Languages does not list.
    const node: ComponentNode = {
      id: "send",
      type: BUTTON_COMPONENT_TYPE,
      configuration: {
        label: "Submit",
        action: "submit"
      }
    };
    const model = buildInspectorModel(node, [], buttonDefinition().propertyEditor, "en");

    const label = model.sections[0]?.fields.find((f) => f.propertyPath === "label");
    expect(label?.control).toBe("localized-text");
    expect(label?.value).toBe("Submit");
  });

  it("falls back to the generic label when a type has no registered definition", () => {
    // Definition-less types keep the previous behaviour rather than producing an empty node.
    const ctrl = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }
    });
    ctrl.add("text");
    expect(ctrl.selectedNode()?.configuration).toMatchObject({ label: "Untitled field" });
  });
});
