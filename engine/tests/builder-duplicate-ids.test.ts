import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A form opened with two components under one id loads: the twins are listed as a problem under
 * the id box of each (the inspector reaches a twin by that id), and nothing else is refused.
 */

const leaf = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {} }),
  capabilities: standardFieldCapabilities()
});

const definitions: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "section", version: "1.0.0", createDefault: () => ({ id: "section", type: "section", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  leaf("text")
];

function controller(content: ComponentNode[]): BuilderController {
  return new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content } }, componentDefinitions: definitions });
}

const text = (id: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration });

describe("twin component ids on load", () => {
  it("loads the form and lists the twins under the id box", () => {
    const ctrl = controller([text("city"), { id: "box", type: "section", configuration: {}, children: { content: [text("city"), text("zip")] } }]);
    expect(ctrl.problemsOf("city")).toEqual([{ target: "id", message: expect.stringContaining('2 components have the id "city"') }]);
    expect(ctrl.problemsOf("zip")).toEqual([]);
    expect(ctrl.problemsOf("root")).toEqual([]);
  });

  it("drops the problem once a draft gives the twin another id, and the rename clears it", () => {
    const ctrl = controller([text("city"), text("city")]);
    ctrl.select("city");
    ctrl.setDraftId("city", "town");
    expect(ctrl.problemsOf("city")).toEqual([]);
    expect(ctrl.commitDraft("city")).toBe(true);
    expect(ctrl.problemsOf("town")).toEqual([]);
    expect(ctrl.problemsOf("city")).toEqual([]);
  });

  it("never refuses a twin's other edits for it", () => {
    const ctrl = controller([text("city"), text("city")]);
    ctrl.select("city");
    ctrl.setDraftProperty("city", "label", "City");
    expect(ctrl.commitDraft("city")).toBe(true);
    expect(ctrl.getProperty("city", "label")).toBe("City");
    // The definition still carries both, and saves as it is.
    expect(JSON.stringify(ctrl.snapshot()).match(/"id":"city"/g)).toHaveLength(2);
  });
});
