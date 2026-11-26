// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { settledPrintEdits, slotResetEdits, titleOnFirstPageEdits, slotEdits, type PrintEdit } from "../form-engine/builder/print/print-settings-model.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";

/** The Print workspace's writes, as the surface makes them: settled, then one setProperties on the form root. */

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", capabilities: standardFieldCapabilities(), ...extra }) as unknown as ComponentDefinition;

function controller(): BuilderController {
  return new BuilderController({
    componentTypes: [{ type: "text", label: "Text" }],
    initialRoot: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
    componentDefinitions: [def("form", { capabilities: [], children: { slots: [{ id: "content", multiple: true }] } }), def("text")]
  });
}

/** What the surface's write() does. */
function write(ctrl: BuilderController, edits: readonly PrintEdit[]): void {
  const settled = settledPrintEdits(ctrl.snapshot().configuration, edits);
  if (settled.length === 0) {
    return;
  }
  ctrl.setProperties(settled.map((edit) => ({ componentId: ctrl.rootId(), propertyPath: edit.propertyPath, value: edit.value })));
}

const stored = (ctrl: BuilderController): string => JSON.stringify(ctrl.snapshot().configuration);

describe("clearing a print setting through the controller", () => {
  it("stores no empty print block for a reset of what was never written, and no undo step", () => {
    const ctrl = controller();
    write(ctrl, slotResetEdits("header", "start"));
    write(ctrl, titleOnFirstPageEdits(true));
    expect(stored(ctrl)).toBe('{"title":"Intake"}');
    expect(ctrl.canUndo()).toBe(false);
  });

  it("takes the empty blocks away with the last setting, in one undo step that brings it back", () => {
    const ctrl = controller();
    write(ctrl, slotEdits("header", "start", "Ref"));
    expect(stored(ctrl)).toBe('{"title":"Intake","print":{"header":{"start":"Ref"}}}');
    write(ctrl, slotResetEdits("header", "start"));
    expect(stored(ctrl)).toBe('{"title":"Intake"}');
    ctrl.undo();
    expect(stored(ctrl)).toBe('{"title":"Intake","print":{"header":{"start":"Ref"}}}');
  });
});
