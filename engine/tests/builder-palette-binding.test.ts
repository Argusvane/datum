import { describe, expect, it } from "vitest";

import { BuilderController, paletteEntriesOf } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { extendBinding, type LiveBinding } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";

/**
 * A component type that belongs to a design-system binding (`ComponentPaletteEntry.binding`: the
 * GCDS plugin's `gcds-card`) is offered by the palette and the add command only while that
 * binding draws the canvas; `componentTypes()` still names it, so a form that holds one labels it.
 */
const root = (): ComponentNode => ({ id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } }) as ComponentNode;
const datum = createDatumBinding();
const ACME: LiveBinding = extendBinding(datum, { id: "acme", label: "Acme" });
const OTHER: LiveBinding = extendBinding(datum, { id: "other", label: "Other" });
const offered = [
  { id: "datum", label: "Datum" },
  { id: "acme", label: "Acme", binding: ACME },
  { id: "other", label: "Other", binding: OTHER }
];
const definition = (type: string, binding?: string): ComponentDefinition =>
  ({ type, version: "1", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [], palette: { label: type, ...(binding !== undefined ? { binding } : {}) } }) as ComponentDefinition;
const types = [{ type: "text", label: "Text" }, ...paletteEntriesOf([definition("acme-card", "acme"), definition("any-note")])];

describe("palette entries that belong to a binding", () => {
  it("paletteEntriesOf carries the binding", () => {
    expect(types.find((entry) => entry.type === "acme-card")?.binding).toBe("acme");
    expect(types.find((entry) => entry.type === "any-note")?.binding).toBeUndefined();
  });

  it("are offered only while that binding draws the canvas", () => {
    const controller = new BuilderController({ initialRoot: root(), componentTypes: types, availableBindings: offered });
    expect(controller.offeredTypes().map((entry) => entry.type)).toEqual(["text", "any-note"]);
    controller.setBindingId("acme");
    expect(controller.offeredTypes().map((entry) => entry.type)).toEqual(["text", "acme-card", "any-note"]);
    controller.setBindingId("other");
    expect(controller.offeredTypes().map((entry) => entry.type)).toEqual(["text", "any-note"]);
    // The full list still names the type, for the label of a node that already holds one.
    expect(controller.componentTypes().map((entry) => entry.type)).toContain("acme-card");
  });

  it("follow the host's own binding when the picker is not used", () => {
    const controller = new BuilderController({ initialRoot: root(), componentTypes: types, binding: ACME, availableBindings: offered });
    expect(controller.offeredTypes().some((entry) => entry.type === "acme-card")).toBe(true);
  });

  it("are the list itself when no type names a binding", () => {
    const plain = [{ type: "text", label: "Text" }];
    const controller = new BuilderController({ initialRoot: root(), componentTypes: plain });
    expect(controller.offeredTypes()).toBe(controller.componentTypes());
  });
});
