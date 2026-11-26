import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A grid nested in a row has no `[]` in its own data path (its entries live at its collection
 * path), but its rules still read the outer row, so they follow the outer row's key moves.
 */

const holder = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: {}, children: { content: [] } }),
  capabilities: [],
  children: { slots: [{ id: "content", multiple: true }] }
});
const DEFS: ComponentDefinition[] = [
  holder("form"),
  holder("container"),
  holder("dataGrid"),
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: {} }), capabilities: standardFieldCapabilities() }
];

const nested = (rules: Record<string, string>, inContainer: boolean): ComponentNode => {
  const lines: ComponentNode = {
    id: "lines",
    type: "dataGrid",
    configuration: {},
    collection: { collectionPath: "lines" },
    rules,
    children: { content: [{ id: "item", type: "text", configuration: {}, rules: { requiredWhen: 'row.item != ""' } }] }
  };
  return {
    id: "orders",
    type: "dataGrid",
    configuration: {},
    collection: { collectionPath: "orders" },
    children: {
      content: [{ id: "ref", type: "text", configuration: {} }, inContainer ? { id: "box", type: "container", configuration: {}, children: { content: [lines] } } : lines]
    }
  };
};

const make = (inContainer: boolean): BuilderController =>
  new BuilderController({
    componentDefinitions: DEFS,
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [nested({ visibleWhen: 'row.ref != ""' }, inContainer)] } }
  });

const linesRules = (ctrl: BuilderController, inContainer: boolean) => {
  const content = ctrl.snapshot().children?.content?.[0]?.children?.content ?? [];
  const lines = inContainer ? content[1]?.children?.content?.[0] : content[1];
  return lines?.rules;
};

describe("the rules of a grid nested in a row follow the outer row's keys", () => {
  for (const inContainer of [false, true]) {
    it(`a rename of the outer row's field${inContainer ? " (the grid sits in a container)" : ""}`, () => {
      const ctrl = make(inContainer);
      ctrl.renameId("ref", "code");
      expect(linesRules(ctrl, inContainer)).toEqual({ visibleWhen: 'row.code != ""' });
      ctrl.undo();
      expect(linesRules(ctrl, inContainer)).toEqual({ visibleWhen: 'row.ref != ""' });
    });
  }

  it("a data key edit of the outer row's field", () => {
    const ctrl = make(false);
    ctrl.setProperty("ref", "dataKey", "reference");
    expect(linesRules(ctrl, false)).toEqual({ visibleWhen: 'row.reference != ""' });
  });

  it("the fields of the nested grid keep reading their own row", () => {
    const ctrl = make(false);
    ctrl.renameId("ref", "code");
    const item = ctrl.snapshot().children?.content?.[0]?.children?.content?.[1]?.children?.content?.[0];
    expect(item?.rules).toEqual({ requiredWhen: 'row.item != ""' });
  });
});
