import { describe, expect, it } from "vitest";

import {
  PATTERN_PRESETS,
  PATTERN_PRESET_PATH,
  buildInspectorModel,
  inspectorHints,
  inspectorWarnings,
  patternPresetOf,
  patternPresetWrites,
  suggestedPatternPreset
} from "../form-engine/builder/property-editor/inspector-model.js";
import { EMAIL_PRESET_MESSAGE, EMAIL_PRESET_PATTERN } from "../form-engine/core/schema/control-hints.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * The Email keyboard is a device hint and validates nothing; the
 * inspector's Format box (the Email preset) is the explicit way to store a pattern and a message,
 * and the Email keyboard only makes the inspector suggest it.
 */

function text(configuration: Record<string, unknown>): ComponentNode {
  return { id: "email", type: "text", configuration: { label: "Email", ...configuration } };
}

const capabilities = standardFieldCapabilities({ pattern: true, inputMode: true });
const modelOf = (node: ComponentNode) => buildInspectorModel(node, capabilities);
const fieldsOf = (node: ComponentNode) => modelOf(node).sections.flatMap((section) => section.fields);

describe("the Format box (Email preset)", () => {
  it("sits under Validation right before Pattern, on a component that has a Pattern box", () => {
    const validation = modelOf(text({})).sections.find((section) => section.id === "validation");
    const paths = validation?.fields.map((field) => field.propertyPath) ?? [];
    expect(paths).toContain(PATTERN_PRESET_PATH);
    expect(paths.indexOf(PATTERN_PRESET_PATH) + 1).toBe(paths.indexOf("pattern"));
  });

  it("is not offered when the component has no Pattern box", () => {
    const bare = buildInspectorModel(text({}), standardFieldCapabilities({}));
    expect(bare.sections.flatMap((section) => section.fields).map((field) => field.propertyPath)).not.toContain(PATTERN_PRESET_PATH);
    // A component with the default fields (no capabilities) has none either.
    expect(buildInspectorModel(text({})).sections.flatMap((section) => section.fields).map((field) => field.propertyPath)).not.toContain(PATTERN_PRESET_PATH);
  });

  it("reads its value back from the stored pattern: none, a preset's, or custom", () => {
    const valueOf = (configuration: Record<string, unknown>) => fieldsOf(text(configuration)).find((field) => field.propertyPath === PATTERN_PRESET_PATH);
    expect(valueOf({})?.value).toBe("");
    expect(valueOf({ pattern: "" })?.value).toBe("");
    expect(valueOf({ pattern: EMAIL_PRESET_PATTERN })?.value).toBe("email");
    expect(valueOf({ pattern: "[A-Z]{3}" })?.value).toBe("custom");
    expect(patternPresetOf(text({ pattern: EMAIL_PRESET_PATTERN }))).toBe("email");
  });

  it("offers Any text and each preset, and Custom pattern only while the stored pattern is none of theirs", () => {
    const choices = (configuration: Record<string, unknown>) => fieldsOf(text(configuration)).find((field) => field.propertyPath === PATTERN_PRESET_PATH)?.choices.map((choice) => choice.value);
    expect(choices({})).toEqual(["", ...PATTERN_PRESETS.map((preset) => preset.id)]);
    expect(choices({ pattern: "[A-Z]{3}" })).toEqual(["", "email", "custom"]);
    const labels = fieldsOf(text({})).find((field) => field.propertyPath === PATTERN_PRESET_PATH)?.choices.map((choice) => choice.label);
    expect(labels).toEqual(["Any text", "Email address"]);
  });

  it("makes choosing a keyboard paint the panel, so the suggestion appears at once (and only where both boxes are)", () => {
    expect(modelOf(text({})).shapeDependsOn).toContain("inputmode");
    expect(buildInspectorModel(text({}), standardFieldCapabilities({ pattern: true })).shapeDependsOn).toBeUndefined();
  });

  it("words itself from the builder's catalog", () => {
    const model = buildInspectorModel(text({}), capabilities, undefined, "en", { words: { locale: "fr", catalog: { fr: { "inspector.preset.email": "Adresse courriel" } } } });
    const field = model.sections.flatMap((section) => section.fields).find((entry) => entry.propertyPath === PATTERN_PRESET_PATH);
    expect(field?.choices.map((choice) => choice.label)).toContain("Adresse courriel");
  });
});

describe("patternPresetWrites", () => {
  it("Email writes the pattern and a default message in that order", () => {
    expect(patternPresetWrites(text({}), "email")).toEqual([
      { path: "pattern", value: EMAIL_PRESET_PATTERN },
      { path: "patternMessage", value: EMAIL_PRESET_MESSAGE }
    ]);
  });

  it("keeps a message the author wrote", () => {
    expect(patternPresetWrites(text({ patternMessage: "Use your work address" }), "email")).toEqual([{ path: "pattern", value: EMAIL_PRESET_PATTERN }]);
  });

  it("Any text takes the pattern away, and the message too while it is a preset's own", () => {
    expect(patternPresetWrites(text({ pattern: EMAIL_PRESET_PATTERN, patternMessage: EMAIL_PRESET_MESSAGE }), "")).toEqual([
      { path: "pattern", value: undefined },
      { path: "patternMessage", value: undefined }
    ]);
    expect(patternPresetWrites(text({ pattern: "[A-Z]{3}", patternMessage: "Three capitals" }), "")).toEqual([{ path: "pattern", value: undefined }]);
  });

  it("writes nothing for Custom pattern or a choice it does not know", () => {
    expect(patternPresetWrites(text({ pattern: "[A-Z]{3}" }), "custom")).toEqual([]);
    expect(patternPresetWrites(text({}), "postal")).toEqual([]);
  });

  it("stores what the validator then reads: the stage refuses abc and takes an address", () => {
    const node = text({ inputmode: "email" });
    const configuration: Record<string, unknown> = { ...(node.configuration as Record<string, unknown>) };
    for (const write of patternPresetWrites(node, "email")) {
      configuration[write.path] = write.value;
    }
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ ...node, configuration }] } };
    const errors = (values: Record<string, unknown>) => (createFieldConstraintsStage(root).validate({ formId: "f", values, locale: "en" }) as { errors: Array<{ code: string }> }).errors.map((entry) => entry.code);
    expect(errors({ email: "abc" })).toEqual(["pattern"]);
    expect(errors({ email: "a@b.ca" })).toEqual([]);
    // The server's kernel reads the same stored definition and agrees.
    expect(runKernel({ formId: "f", values: { email: "abc" }, locale: "en", form: root }, []).errors.map((entry) => entry.code)).toEqual(["pattern"]);
    expect(runKernel({ formId: "f", values: { email: "a@b.ca" }, locale: "en", form: root }, []).errors).toEqual([]);
  });
});

describe("the Email keyboard's suggestion", () => {
  it("shows Suggest: validate as email, as a hint and never a warning, when the keyboard is Email and no pattern is set", () => {
    const node = text({ inputmode: "email" });
    expect(suggestedPatternPreset(node)?.id).toBe("email");
    expect(inspectorHints(node)).toEqual([{ fieldId: PATTERN_PRESET_PATH, message: "Suggest: validate as email" }]);
    expect(modelOf(node).hints).toEqual([{ fieldId: PATTERN_PRESET_PATH, message: "Suggest: validate as email" }]);
    expect(inspectorWarnings(node)).toEqual([]);
    expect(modelOf(node).warnings).toBeUndefined();
  });

  it("treats a blank pattern as none", () => {
    expect(inspectorHints(text({ inputmode: "email", pattern: "" }))).toHaveLength(1);
  });

  it("is quiet once a pattern is set, on another keyboard, with no keyboard, or on another type", () => {
    expect(inspectorHints(text({ inputmode: "email", pattern: EMAIL_PRESET_PATTERN }))).toEqual([]);
    expect(inspectorHints(text({ inputmode: "email", pattern: "[a-z]+" }))).toEqual([]);
    expect(inspectorHints(text({ inputmode: "tel" }))).toEqual([]);
    expect(inspectorHints(text({}))).toEqual([]);
    expect(inspectorHints({ id: "area", type: "textarea", configuration: { label: "Notes", inputmode: "email" } })).toEqual([]);
  });

  it("never applies the preset by itself: choosing the keyboard stores nothing but the keyboard", () => {
    const node = text({ inputmode: "email" });
    expect((node.configuration as Record<string, unknown>).pattern).toBeUndefined();
    expect(patternPresetOf(node)).toBe("");
  });

  it("is worded from the builder's catalog", () => {
    expect(inspectorHints(text({ inputmode: "email" }), { locale: "fr", catalog: { fr: { "inspector.hint.presetEmail": "Suggestion : valider comme courriel" } } })[0]?.message).toBe("Suggestion : valider comme courriel");
  });
});
